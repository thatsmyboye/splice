import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { explainMatches } from "@/lib/anthropic";
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
    // Analysis not yet complete — return empty (client should retry)
    return NextResponse.json({ matches: [], cachedAt: null });
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
    return NextResponse.json({ matches: [], cachedAt: null });
  }

  // Fetch track metadata for results
  const matchSpotifyIds = rawMatches.map(
    (m: { spotify_id: string }) => m.spotify_id
  );
  const { data: trackMetadata } = await serviceSupabase
    .from("tracks")
    .select("spotify_id, title, artist, artwork_url, preview_url")
    .in("spotify_id", matchSpotifyIds);

  const trackMap = new Map(
    (trackMetadata ?? []).map((t) => [t.spotify_id, t])
  );

  // Get source track info for Claude context
  const { data: sourceTrackData } = await serviceSupabase
    .from("tracks")
    .select("title, artist")
    .eq("spotify_id", sourceSpotifyId)
    .single();

  // Claude re-ranking explanations (top 10 only to save tokens)
  const descriptor = moment.moment_descriptor as MomentDescriptor;
  const matchesForClaude = rawMatches
    .filter((m: { spotify_id: string }) => trackMap.has(m.spotify_id))
    .slice(0, 10)
    .map((m: { spotify_id: string; similarity: number }) => {
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

  // Build final results
  const matches: MomentMatch[] = rawMatches
    .filter((m: { spotify_id: string }) => trackMap.has(m.spotify_id))
    .map(
      (m: {
        spotify_id: string;
        similarity: number;
        segments: Array<{ start_s: number }> | null;
      }) => {
        const t = trackMap.get(m.spotify_id)!;
        const firstSegmentStart = m.segments?.[0]?.start_s ?? 0;
        return {
          spotify_id: m.spotify_id,
          title: t.title,
          artist: t.artist,
          artwork_url: t.artwork_url ?? null,
          preview_url: t.preview_url ?? null,
          timestamp_s: firstSegmentStart,
          similarity_score: m.similarity,
          claude_explanation: explanations.get(m.spotify_id) ?? "",
          spotify_embed_url: `https://open.spotify.com/embed/track/${m.spotify_id}`,
        };
      }
    );

  // Cache results (7-day TTL set by DB default)
  await serviceSupabase
    .from("moment_matches")
    .upsert({ moment_id: momentId, results: matches }, { onConflict: "moment_id" });

  return NextResponse.json({ matches, cachedAt: null });
}
