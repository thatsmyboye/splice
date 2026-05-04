import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { explainMatches, suggestTrackMatches } from "@/lib/anthropic";
import { getMBRecordings } from "@/lib/musicbrainz";
import { getSongByISRC } from "@/lib/apple-music";
import { searchTracks } from "@/lib/spotify";
import { z } from "zod";
import type { MomentMatch, MomentDescriptor, SourceAnalysis } from "@splice/types";

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

/**
 * When the pgvector catalog is empty, ask Claude to suggest real songs and
 * resolve them to Spotify metadata. Used as a fallback until enough tracks
 * have been analyzed to produce vector results.
 */
async function buildClaudeSuggestions(params: {
  descriptor: MomentDescriptor;
  sourceSpotifyId: string;
  serviceSupabase: ReturnType<typeof getServiceClient>;
}): Promise<MomentMatch[]> {
  const { descriptor, sourceSpotifyId, serviceSupabase } = params;

  const { data: sourceTrackData } = await serviceSupabase
    .from("tracks")
    .select("title, artist")
    .eq("spotify_id", sourceSpotifyId)
    .single();

  if (!sourceTrackData) return [];

  let suggestions: Array<{ title: string; artist: string; explanation: string; similarity_score: number }>;
  try {
    suggestions = await suggestTrackMatches({
      descriptor,
      sourceTrack: {
        title: sourceTrackData.title,
        artist: sourceTrackData.artist,
      },
    });
  } catch {
    return [];
  }

  const matches: MomentMatch[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    try {
      const results = await searchTracks(`${s.title} ${s.artist}`, 1);
      if (results.length === 0) continue;
      const t = results[0];
      if (seen.has(t.id) || t.id === sourceSpotifyId) continue;
      seen.add(t.id);

      const similarity = s.similarity_score;

      matches.push({
        spotify_id: t.id,
        title: t.name,
        artist: t.artists.map((a: { name: string }) => a.name).join(", "),
        artwork_url: t.album?.images?.[0]?.url ?? null,
        preview_url: t.preview_url ?? null,
        timestamp_s: null,
        similarity_score: similarity,
        claude_explanation: s.explanation,
        spotify_embed_url: `https://open.spotify.com/embed/track/${t.id}`,
        apple_music_url: null,
        bpm: null,
        key_name: null,
        key_mode: null,
        time_signature: null,
        harmonic_rhythm: null,
        chord_label: null,
        popularity: t.popularity ?? null,
      });
    } catch {
      // Skip suggestions whose Spotify search fails
    }
  }

  return matches;
}

function chordAtTimestamp(
  segments: Array<{ start_s: number; duration_s: number; chord_label?: string }>,
  timestamp_s: number | null
): string | null {
  if (!segments?.length) return null;
  if (timestamp_s === null) return segments[0]?.chord_label ?? null;
  const seg =
    segments.find((s) => timestamp_s >= s.start_s && timestamp_s < s.start_s + s.duration_s) ??
    segments[0];
  return seg?.chord_label ?? null;
}

/** Build an Apple Music URL from a catalog ID. */
function amUrl(appleId: string): string {
  return `https://music.apple.com/album/${appleId}`;
}

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

  // Check cache — key is (moment_id, source_spotify_id) so results are
  // never shared across different source tracks.
  const { data: cached } = await serviceSupabase
    .from("moment_matches")
    .select("results, created_at")
    .eq("moment_id", momentId)
    .eq("source_spotify_id", sourceSpotifyId)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (cached) {
    return NextResponse.json({
      matches: cached.results,
      cachedAt: cached.created_at,
      analysis_pending: false,
      source_analysis: null,
    });
  }

  // Fetch moment descriptor
  const { data: moment } = await serviceSupabase
    .from("moments")
    .select("moment_descriptor, timestamp_start_s")
    .eq("id", momentId)
    .single();

  if (!moment?.moment_descriptor) {
    return NextResponse.json({ error: "Moment not found" }, { status: 404 });
  }

  const descriptor = moment.moment_descriptor as MomentDescriptor;

  // Get source track embedding + harmonic context
  const { data: sourceFeatures } = await serviceSupabase
    .from("track_features")
    .select("embedding, key_name, key_mode, bpm, time_signature, analysis_version, segments")
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
      source_analysis: null,
    });
  }

  const isV2 = sourceFeatures.analysis_version === "2.0";

  // Build source_analysis for the frontend harmonic header
  const source_analysis: SourceAnalysis | null = isV2
    ? {
        key_name: sourceFeatures.key_name ?? null,
        key_mode: (sourceFeatures.key_mode as "major" | "minor" | null) ?? null,
        bpm: sourceFeatures.bpm ?? null,
        time_signature: (sourceFeatures.time_signature as 3 | 4 | null) ?? null,
        chord_label: chordAtTimestamp(
          (sourceFeatures.segments ?? []) as Array<{ start_s: number; duration_s: number; chord_label?: string }>,
          (moment as { timestamp_start_s?: number | null }).timestamp_start_s ?? null
        ),
      }
    : null;

  // pgvector similarity search via RPC (with optional COF key boosting for v2)
  const { data: rawMatches, error: matchError } = await serviceSupabase.rpc(
    "match_tracks",
    {
      query_embedding: sourceFeatures.embedding,
      match_count: limit,
      exclude_spotify_id: sourceSpotifyId,
      source_key_name: isV2 ? (sourceFeatures.key_name ?? null) : null,
      source_key_mode: isV2 ? (sourceFeatures.key_mode ?? null) : null,
      key_boost_weight: isV2 ? 0.08 : 0.0,
    }
  );

  if (matchError) {
    return NextResponse.json(
      { error: "Match query failed" },
      { status: 500 }
    );
  }

  // Synthetic embeddings (created from Claude descriptors) live in a different
  // vector space than AcousticBrainz embeddings, so cosine similarity between
  // the two spaces is not meaningful. Fewer than 5 results signals that the
  // query vector didn't land near the catalog — fall back to Claude suggestions.
  const MIN_VECTOR_RESULTS = 5;
  if (!rawMatches || rawMatches.length < MIN_VECTOR_RESULTS) {
    // Insufficient vector matches — ask Claude to suggest similar tracks
    const matches = await buildClaudeSuggestions({
      descriptor,
      sourceSpotifyId,
      serviceSupabase,
    });

    if (matches.length > 0) {
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ).toISOString();
      await serviceSupabase
        .from("moment_matches")
        .upsert(
          { moment_id: momentId, source_spotify_id: sourceSpotifyId, results: matches, expires_at: expiresAt },
          { onConflict: "moment_id,source_spotify_id" }
        );
    }

    return NextResponse.json({
      matches,
      cachedAt: null,
      analysis_pending: false,
      source_analysis,
    });
  }

  // Fetch segments for matched tracks so we can show a real timestamp
  const matchedIds = (rawMatches as Array<{ spotify_id: string }>).map((m) => m.spotify_id);
  const { data: featuresRows } = await serviceSupabase
    .from("track_features")
    .select("spotify_id, segments")
    .in("spotify_id", matchedIds);

  const segmentsMap = new Map<string, Array<{ start_s: number; duration_s: number; chord_label?: string }>>(
    (featuresRows ?? []).map((f) => [f.spotify_id, f.segments ?? []])
  );

  // Split results: real Spotify IDs vs AcousticBrainz ("ab:{mbid}") prefixed
  const spotifyIds: string[] = [];
  const abMbids: string[] = [];

  for (const m of rawMatches as Array<{ spotify_id: string }>) {
    if (m.spotify_id.startsWith("ab:")) {
      abMbids.push(m.spotify_id.slice(3));
    } else {
      spotifyIds.push(m.spotify_id);
    }
  }

  // Fetch Spotify track metadata from our tracks table (includes apple_music_id)
  const { data: spotifyMeta } = spotifyIds.length
    ? await serviceSupabase
        .from("tracks")
        .select("spotify_id, title, artist, artwork_url, preview_url, popularity, apple_music_id")
        .in("spotify_id", spotifyIds)
    : { data: [] };

  type TrackEntry = {
    title: string;
    artist: string;
    artwork_url: string | null;
    preview_url: string | null;
    popularity: number | null;
    apple_music_id: string | null;
  };

  const trackMap = new Map<string, TrackEntry>(
    (spotifyMeta ?? []).map((t) => [
      t.spotify_id,
      {
        title: t.title,
        artist: t.artist,
        artwork_url: t.artwork_url,
        preview_url: t.preview_url,
        popularity: t.popularity ?? null,
        apple_music_id: t.apple_music_id ?? null,
      },
    ])
  );

  // Resolve AcousticBrainz metadata: check cache first, then MusicBrainz API.
  // MusicBrainz now returns ISRCs alongside artist-credits, so we can attempt
  // Apple Music resolution for newly-fetched AB tracks.
  if (abMbids.length > 0) {
    const { data: cached_mb } = await serviceSupabase
      .from("musicbrainz_cache")
      .select("mbid, title, artist, isrc, apple_music_id, popularity")
      .in("mbid", abMbids);

    const cachedMbids = new Set((cached_mb ?? []).map((r) => r.mbid));

    for (const row of cached_mb ?? []) {
      trackMap.set(`ab:${row.mbid}`, {
        title: row.title,
        artist: row.artist,
        artwork_url: null,
        preview_url: null,
        popularity: row.popularity ?? null,
        apple_music_id: row.apple_music_id ?? null,
      });
    }

    const uncachedMbids = abMbids.filter((id) => !cachedMbids.has(id));

    if (uncachedMbids.length > 0) {
      const fetched = await getMBRecordings(uncachedMbids);

      // Resolve Apple Music IDs and Spotify popularity in parallel.
      // Both use the ISRC when available; failures are silently skipped.
      const [amLookups, spotifyLookups] = await Promise.all([
        Promise.allSettled(
          Array.from(fetched.values()).map(async (info) => {
            if (!info.isrc) return { mbid: info.mbid, appleId: null };
            const amSong = await getSongByISRC(info.isrc);
            return { mbid: info.mbid, appleId: amSong?.id ?? null };
          })
        ),
        Promise.allSettled(
          Array.from(fetched.values()).map(async (info) => {
            if (!info.isrc) return { mbid: info.mbid, popularity: null };
            const results = await searchTracks(`isrc:${info.isrc}`, 1);
            const pop = results?.[0]?.popularity;
            return { mbid: info.mbid, popularity: typeof pop === "number" ? pop : null };
          })
        ),
      ]);

      const appleIds = new Map<string, string | null>();
      amLookups.forEach((r) => {
        if (r.status === "fulfilled") appleIds.set(r.value.mbid, r.value.appleId);
      });

      const spotifyPopularities = new Map<string, number | null>();
      spotifyLookups.forEach((r) => {
        if (r.status === "fulfilled") spotifyPopularities.set(r.value.mbid, r.value.popularity);
      });

      const newRows = Array.from(fetched.values()).map((info) => ({
        mbid: info.mbid,
        title: info.title,
        artist: info.artist,
        isrc: info.isrc ?? null,
        apple_music_id: appleIds.get(info.mbid) ?? null,
        popularity: spotifyPopularities.get(info.mbid) ?? null,
      }));

      if (newRows.length > 0) {
        try {
          await serviceSupabase
            .from("musicbrainz_cache")
            .upsert(newRows, { onConflict: "mbid" });
        } catch {
          // Non-fatal
        }
      }

      for (const [mbid, info] of fetched) {
        trackMap.set(`ab:${mbid}`, {
          title: info.title,
          artist: info.artist,
          artwork_url: null,
          preview_url: null,
          popularity: spotifyPopularities.get(mbid) ?? null,
          apple_music_id: appleIds.get(mbid) ?? null,
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

  type RawMatch = {
    spotify_id: string;
    similarity: number;
    bpm: number | null;
    key_name: string | null;
    key_mode: string | null;
    time_signature: number | null;
    harmonic_rhythm: number | null;
  };

  // Claude re-ranking explanations (top 10 only to save tokens)
  const matchesForClaude = (rawMatches as RawMatch[])
    .filter((m) => trackMap.has(m.spotify_id))
    .slice(0, 10)
    .map((m) => {
      const t = trackMap.get(m.spotify_id)!;
      return {
        spotify_id: m.spotify_id,
        title: t.title,
        artist: t.artist,
        similarity_score: m.similarity,
        key_name: m.key_name,
        key_mode: m.key_mode,
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
  const matches: MomentMatch[] = (rawMatches as RawMatch[])
    .filter((m) => trackMap.has(m.spotify_id))
    .map((m) => {
      const t = trackMap.get(m.spotify_id)!;
      const segments = segmentsMap.get(m.spotify_id);
      const firstSeg = segments?.[0];
      const isAB = m.spotify_id.startsWith("ab:");
      return {
        spotify_id: m.spotify_id,
        title: t.title,
        artist: t.artist,
        artwork_url: t.artwork_url,
        preview_url: t.preview_url,
        timestamp_s: firstSeg?.start_s ?? null,
        similarity_score: m.similarity,
        claude_explanation: explanations.get(m.spotify_id) ?? "",
        spotify_embed_url: isAB
          ? `https://musicbrainz.org/recording/${m.spotify_id.slice(3)}`
          : `https://open.spotify.com/embed/track/${m.spotify_id}`,
        apple_music_url: t.apple_music_id ? amUrl(t.apple_music_id) : null,
        bpm: m.bpm ?? null,
        key_name: m.key_name ?? null,
        key_mode: (m.key_mode as "major" | "minor" | null) ?? null,
        time_signature: (m.time_signature as 3 | 4 | null) ?? null,
        harmonic_rhythm: m.harmonic_rhythm ?? null,
        chord_label: firstSeg?.chord_label ?? null,
        popularity: t.popularity,
      };
    });

  // Cache results with a fresh 7-day TTL
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await serviceSupabase
    .from("moment_matches")
    .upsert(
      { moment_id: momentId, source_spotify_id: sourceSpotifyId, results: matches, expires_at: expiresAt },
      { onConflict: "moment_id,source_spotify_id" }
    );

  return NextResponse.json({ matches, cachedAt: null, analysis_pending: false, source_analysis });
}
