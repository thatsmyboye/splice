import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { explainMatches } from "@/lib/anthropic";
import { getMBRecordings } from "@/lib/musicbrainz";
import { z } from "zod";
import type { MomentMatch, MomentDescriptor } from "@splice/types";

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

const RequestSchema = z.object({
  momentId: z.string().uuid(),
  sourceSpotifyId: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(20),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { momentId, sourceSpotifyId, limit } = parsed.data;
  const serviceSupabase = getServiceClient();

  // Check cache
  const { data: cached } = await serviceSupabase
    .from("moment_matches")
    .select("results, created_at")
    .eq("moment_id", momentId)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (cached) {
    return NextResponse.json({
      matches: cached.results,
      cachedAt: cached.created_at,
      analysis_pending: false,
    });
  }

  // Fetch moment descriptor
  const { data: moment } = await serviceSupabase
    .from("moments")
    .select("moment_descriptor")
    .eq("id", momentId)
    .single();

  if (!moment?.moment_descriptor) {
    return NextResponse.json({ error: "Moment not found" }, { status: 404 });
  }

  // Get source track embedding
  const { data: sourceFeatures } = await serviceSupabase
    .from("track_features")
    .select("embedding")
    .eq("spotify_id", sourceSpotifyId)
    .single();

  if (!sourceFeatures?.embedding) {
    // Check if analysis is in flight so the client knows to poll and retry
    const { data: job } = await serviceSupabase
      .from("analysis_jobs")
      .select("status")
      .eq("spotify_id", sourceSpotifyId)
      .in("status", ["pending", "processing"])
      .limit(1)
      .single();

    return NextResponse.json({
      matches: [],
      cachedAt: null,
      analysis_pending: !!job,
    });
  }

  // pgvector similarity search via RPC
  const { data: rawMatches, error: matchError } = await serviceSupabase.rpc(
    "match_tracks",
    {
      query_embedding: sourceFeatures.embedding,
      match_count: limit,
      exclude_spotify_id: sourceSpotifyId,
    }
  );

  if (matchError) {
    return NextResponse.json(
      { error: "Match query failed" },
      { status: 500 }
    );
  }

  if (!rawMatches || rawMatches.length === 0) {
    return NextResponse.json({ matches: [], cachedAt: null, analysis_pending: false });
  }

  // Split results: real Spotify IDs vs AcousticBrainz ("ab:{mbid}") prefixed
  const spotifyIds: string[] = [];
  const abMbids: string[] = [];

  for (const m of rawMatches as Array<{ spotify_id: string }>) {
    if (m.spotify_id.startsWith("ab:")) {
      abMbids.push(m.spotify_id.slice(3)); // strip "ab:" prefix
    } else {
      spotifyIds.push(m.spotify_id);
    }
  }

  // Fetch Spotify track metadata from our tracks table
  const { data: spotifyMeta } = spotifyIds.length
    ? await serviceSupabase
        .from("tracks")
        .select("spotify_id, title, artist, artwork_url, preview_url")
        .in("spotify_id", spotifyIds)
    : { data: [] };

  const trackMap = new Map(
    (spotifyMeta ?? []).map((t) => [
      t.spotify_id,
      { title: t.title, artist: t.artist, artwork_url: t.artwork_url, preview_url: t.preview_url },
    ])
  );

  // Resolve AcousticBrainz metadata: check cache first, then MusicBrainz API
  if (abMbids.length > 0) {
    const { data: cached_mb } = await serviceSupabase
      .from("musicbrainz_cache")
      .select("mbid, title, artist")
      .in("mbid", abMbids);

    const cachedMbids = new Set((cached_mb ?? []).map((r) => r.mbid));

    for (const row of cached_mb ?? []) {
      trackMap.set(`ab:${row.mbid}`, {
        title: row.title,
        artist: row.artist,
        artwork_url: null,
        preview_url: null,
      });
    }

    const uncachedMbids = abMbids.filter((id) => !cachedMbids.has(id));

    if (uncachedMbids.length > 0) {
      const fetched = await getMBRecordings(uncachedMbids);

      const newRows = Array.from(fetched.values()).map((info) => ({
        mbid: info.mbid,
        title: info.title,
        artist: info.artist,
      }));

      if (newRows.length > 0) {
        // Cache for future requests — ignore errors
        await serviceSupabase
          .from("musicbrainz_cache")
          .upsert(newRows, { onConflict: "mbid" })
          .throwOnError()
          .catch(() => {});
      }

      for (const [mbid, info] of fetched) {
        trackMap.set(`ab:${mbid}`, {
          title: info.title,
          artist: info.artist,
          artwork_url: null,
          preview_url: null,
        });
      }
    }
  }

  // Get source track info for Claude context
  const { data: sourceTrackData } = await serviceSupabase
    .from("tracks")
    .select("title, artist")
    .eq("spotify_id", sourceSpotifyId)
    .single();

  // Claude re-ranking explanations (top 10 only to save tokens)
  const descriptor = moment.moment_descriptor as MomentDescriptor;
  const matchesForClaude = (rawMatches as Array<{ spotify_id: string; similarity: number }>)
    .filter((m) => trackMap.has(m.spotify_id))
    .slice(0, 10)
    .map((m) => {
      const t = trackMap.get(m.spotify_id)!;
      return {
        spotify_id: m.spotify_id,
        title: t.title,
        artist: t.artist,
        similarity_score: m.similarity,
      };
    });

  let explanations = new Map<string, string>();
  if (sourceTrackData && matchesForClaude.length > 0) {
    try {
      explanations = await explainMatches({
        sourceMomentDescriptor: descriptor,
        sourceTrack: {
          title: sourceTrackData.title,
          artist: sourceTrackData.artist,
        },
        matches: matchesForClaude,
      });
    } catch {
      // Proceed without explanations
    }
  }

  // Build final results — include both Spotify and AcousticBrainz tracks
  const matches: MomentMatch[] = (
    rawMatches as Array<{
      spotify_id: string;
      similarity: number;
      segments: Array<{ start_s: number }> | null;
    }>
  )
    .filter((m) => trackMap.has(m.spotify_id))
    .map((m) => {
      const t = trackMap.get(m.spotify_id)!;
      const firstSegmentStart = m.segments?.[0]?.start_s ?? 0;
      const isAB = m.spotify_id.startsWith("ab:");
      return {
        spotify_id: m.spotify_id,
        title: t.title,
        artist: t.artist,
        artwork_url: t.artwork_url,
        preview_url: t.preview_url,
        timestamp_s: firstSegmentStart,
        similarity_score: m.similarity,
        claude_explanation: explanations.get(m.spotify_id) ?? "",
        // AcousticBrainz tracks link to MusicBrainz instead of Spotify
        spotify_embed_url: isAB
          ? `https://musicbrainz.org/recording/${m.spotify_id.slice(3)}`
          : `https://open.spotify.com/embed/track/${m.spotify_id}`,
      };
    });

  // Cache results (7-day TTL set by DB default)
  await serviceSupabase
    .from("moment_matches")
    .upsert({ moment_id: momentId, results: matches }, { onConflict: "moment_id" });

  return NextResponse.json({ matches, cachedAt: null, analysis_pending: false });
}
