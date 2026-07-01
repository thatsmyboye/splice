import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { explainMatches } from "@/lib/anthropic";
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
  deepCut: z.boolean().default(false),
});

// Spotify popularity 0–100. Tracks at or below this threshold are considered obscure.
// Roughly corresponds to artists with fewer than ~1M streams total.
const DEEP_CUT_MAX_POPULARITY = 40;

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

/**
 * Ask the analysis service to embed the feature window defined by
 * [timestamp_s, timestamp_end_s) into the same 128-dim space as the catalog.
 * Returns null on any failure so callers can fall back to the track embedding.
 */
async function fetchWindowEmbedding(params: {
  segments: unknown[];
  timestamp_s: number;
  timestamp_end_s: number | null;
  bpm: number | null;
  key_name: string | null;
  key_mode: string | null;
  time_signature: number | null;
  harmonic_rhythm: number | null;
  danceability: number | null;
  dynamic_complexity: number | null;
}): Promise<number[] | null> {
  const serviceUrl = process.env.ANALYSIS_SERVICE_URL;
  const serviceSecret = process.env.ANALYSIS_SERVICE_SECRET;
  if (!serviceUrl || !serviceSecret) return null;

  try {
    const res = await fetch(`${serviceUrl}/embed-window`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Secret": serviceSecret,
      },
      body: JSON.stringify({
        segments: params.segments,
        timestamp_s: params.timestamp_s,
        timestamp_end_s: params.timestamp_end_s ?? undefined,
        bpm: params.bpm ?? 120,
        key_name: params.key_name ?? "C",
        key_mode: params.key_mode ?? "major",
        time_signature: params.time_signature ?? 4,
        harmonic_rhythm: params.harmonic_rhythm ?? 0,
        danceability: params.danceability ?? 0.5,
        dynamic_complexity: params.dynamic_complexity ?? 0,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embedding: number[] };
    return data.embedding ?? null;
  } catch {
    return null;
  }
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

  const { momentId, sourceSpotifyId, limit, deepCut } = parsed.data;
  const serviceSupabase = getServiceClient();

  // Cache key includes ":deep" suffix for deep cut results so they're stored
  // separately from normal results for the same moment.
  const cacheSourceId = deepCut ? `${sourceSpotifyId}:deep` : sourceSpotifyId;

  // Check cache — key is (moment_id, cache_source_id) so results are
  // never shared across different source tracks or modes.
  const { data: cached } = await serviceSupabase
    .from("moment_matches")
    .select("results, created_at")
    .eq("moment_id", momentId)
    .eq("source_spotify_id", cacheSourceId)
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

  // Fetch moment descriptor and timestamp window
  const { data: moment } = await serviceSupabase
    .from("moments")
    .select("moment_descriptor, timestamp_start_s, timestamp_end_s")
    .eq("id", momentId)
    .single();

  if (!moment?.moment_descriptor) {
    return NextResponse.json({ error: "Moment not found" }, { status: 404 });
  }

  const descriptor = moment.moment_descriptor as MomentDescriptor;

  // Get source track embedding + harmonic context
  const { data: sourceFeatures } = await serviceSupabase
    .from("track_features")
    .select("embedding, key_name, key_mode, bpm, time_signature, harmonic_rhythm, danceability, dynamic_complexity, analysis_version, segments")
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

  // When deep cut is on, over-fetch candidates so the popularity filter has enough
  // material to find genuinely obscure tracks. Popular songs cluster at the top of
  // the similarity ranking, so we need to look further down the list.
  const candidateCount = deepCut ? Math.min(limit * 5, 100) : limit;

  // Resolve the query embedding. When the source track has v2.0 analysis and
  // the user selected a timestamp (not description-only), ask the analysis
  // service to embed just the window's segments so the search is moment-aware
  // rather than track-level. Fall back to the stored track embedding on failure.
  const momentTimestamp = (moment as { timestamp_start_s?: number | null }).timestamp_start_s ?? null;
  const momentTimestampEnd = (moment as { timestamp_end_s?: number | null }).timestamp_end_s ?? null;

  let queryEmbedding: number[] = sourceFeatures.embedding as number[];

  if (
    isV2 &&
    momentTimestamp !== null &&
    Array.isArray(sourceFeatures.segments) &&
    (sourceFeatures.segments as unknown[]).length > 0
  ) {
    const windowEmbedding = await fetchWindowEmbedding({
      segments: sourceFeatures.segments as unknown[],
      timestamp_s: momentTimestamp,
      timestamp_end_s: momentTimestampEnd,
      bpm: sourceFeatures.bpm ?? null,
      key_name: sourceFeatures.key_name ?? null,
      key_mode: sourceFeatures.key_mode ?? null,
      time_signature: sourceFeatures.time_signature ?? null,
      harmonic_rhythm: (sourceFeatures as { harmonic_rhythm?: number | null }).harmonic_rhythm ?? null,
      danceability: (sourceFeatures as { danceability?: number | null }).danceability ?? null,
      dynamic_complexity: (sourceFeatures as { dynamic_complexity?: number | null }).dynamic_complexity ?? null,
    });
    if (windowEmbedding) {
      queryEmbedding = windowEmbedding;
    }
  }

  // pgvector similarity search via RPC (with optional COF key boosting for v2)
  const { data: rawMatches, error: matchError } = await serviceSupabase.rpc(
    "match_tracks",
    {
      query_embedding: queryEmbedding,
      match_count: candidateCount,
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

  // Only show matches that clear a genuine-similarity bar — otherwise the
  // over-fetched candidate tail (which pgvector always returns regardless of
  // quality once the catalog has a handful of rows) gets displayed as if it
  // were a real match. This threshold is a placeholder tuned for the current
  // mixed-embedding-space catalog; retune once the bulk-seed catalog (single
  // embedding space, real segment-level features throughout) is in place.
  const MIN_SIMILARITY_SCORE = 0.5;
  const qualifiedMatches = (rawMatches ?? []).filter(
    (m: { similarity: number }) => m.similarity >= MIN_SIMILARITY_SCORE
  );

  if (qualifiedMatches.length === 0) {
    // No real match clears the bar — honest empty state, no fabricated
    // suggestions. Cache the empty result so we don't re-run the RPC on
    // every repeat view of the same moment within the TTL window.
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await serviceSupabase
      .from("moment_matches")
      .upsert(
        { moment_id: momentId, source_spotify_id: cacheSourceId, results: [], expires_at: expiresAt },
        { onConflict: "moment_id,source_spotify_id" }
      );

    return NextResponse.json({
      matches: [],
      cachedAt: null,
      analysis_pending: false,
      source_analysis,
    });
  }

  // Fetch segments for matched tracks so we can show a real timestamp
  const matchedIds = qualifiedMatches.map((m: { spotify_id: string }) => m.spotify_id);
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

  for (const m of qualifiedMatches as Array<{ spotify_id: string }>) {
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

  // Build preliminary match objects for all resolved candidates
  const preliminaryMatches: MomentMatch[] = (qualifiedMatches as RawMatch[])
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
        claude_explanation: "",
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

  // Apply deep cut filter before Claude explanations so explanations target the
  // tracks the user will actually see, not the full over-fetched candidate set.
  const sourceArtistLower = sourceTrackData?.artist.toLowerCase() ?? "";
  const filteredMatches = deepCut
    ? preliminaryMatches
        .filter((m) => {
          const popularityOk = m.popularity === null || m.popularity <= DEEP_CUT_MAX_POPULARITY;
          const artistLower = m.artist.toLowerCase();
          const sameArtist =
            artistLower.includes(sourceArtistLower) || sourceArtistLower.includes(artistLower);
          return popularityOk && !sameArtist;
        })
        .slice(0, limit)
    : preliminaryMatches;

  // Claude re-ranking explanations — explain whichever tracks survived the filter
  // (top 10 only to save tokens)
  const matchesForClaude = filteredMatches.slice(0, 10).map((m) => ({
    spotify_id: m.spotify_id,
    title: m.title,
    artist: m.artist,
    similarity_score: m.similarity_score,
    key_name: m.key_name,
    key_mode: m.key_mode,
  }));

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

  const matches: MomentMatch[] = filteredMatches.map((m) => ({
    ...m,
    claude_explanation: explanations.get(m.spotify_id) ?? "",
  }));

  // Cache results with a fresh 7-day TTL
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await serviceSupabase
    .from("moment_matches")
    .upsert(
      { moment_id: momentId, source_spotify_id: cacheSourceId, results: matches, expires_at: expiresAt },
      { onConflict: "moment_id,source_spotify_id" }
    );

  return NextResponse.json({ matches, cachedAt: null, analysis_pending: false, source_analysis });
}
