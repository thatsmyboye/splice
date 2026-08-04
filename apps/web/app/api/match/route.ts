import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { explainMatches } from "@/lib/anthropic";
import { z } from "zod";
import { chordAtTimestamp, type TrackSegment } from "@/lib/segments";
import { isDeepCutEligible, splitArtistNames } from "@/lib/matching";
import { embedText, EMBEDDING_MODEL_ID } from "@/lib/analysis-service";
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

/**
 * Minimum cosine similarity for a window to be shown as a match.
 *
 * PROVISIONAL. The previous 0.5 threshold was calibrated against nothing and
 * admitted 99.97% of the catalog, because the old embeddings were
 * all-non-negative unit vectors whose pairwise cosine is high by construction.
 * CLAP embeddings spread much more usefully, but the right cut still has to be
 * measured against a real seeded catalog — retune once Phase 4 lands.
 */
const MIN_SIMILARITY_SCORE = Number(process.env.MATCH_MIN_SIMILARITY ?? "0.35");

/**
 * How much the audio window counts vs. the typed description when the user
 * supplies both. Audio leads because it's the more specific signal; the text
 * acts as a steer ("...but the quiet part").
 */
const AUDIO_QUERY_WEIGHT = 0.65;

/** Over-fetch factor for Deep Cut, which discards most candidates. */
const DEEP_CUT_CANDIDATE_MULTIPLIER = 5;

function l2Normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  return mag > 1e-8 ? vec.map((x) => x / mag) : vec;
}

/**
 * pgvector values come back over PostgREST as their text form: "[0.1,0.2,...]".
 * Returns null for anything unparseable so callers can fall back.
 */
function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

/** Weighted blend of two unit vectors, renormalized. */
function blendVectors(a: number[], b: number[], weightA: number): number[] {
  return l2Normalize(a.map((x, i) => x * weightA + (b[i] ?? 0) * (1 - weightA)));
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

  // Cache key includes ":deep" so deep-cut results are stored separately from
  // normal results for the same moment.
  const cacheSourceId = deepCut ? `${sourceSpotifyId}:deep` : sourceSpotifyId;

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

  const { data: moment } = await serviceSupabase
    .from("moments")
    .select("moment_descriptor, timestamp_start_s, timestamp_end_s, user_description")
    .eq("id", momentId)
    .single();

  if (!moment?.moment_descriptor) {
    return NextResponse.json({ error: "Moment not found" }, { status: 404 });
  }

  const descriptor = moment.moment_descriptor as MomentDescriptor;
  const momentStart = (moment.timestamp_start_s as number | null) ?? null;
  const momentEnd = (moment.timestamp_end_s as number | null) ?? null;
  const userDescription = (moment.user_description as string | null) ?? null;

  // ── Build the query vector ────────────────────────────────────────────────
  //
  // Audio side: mean-pool the source track's own windows over the selected
  // span, in the database. The old implementation round-tripped to the
  // analysis service's /embed-window to rebuild a vector from stored features;
  // now that per-window embeddings are persisted, the vector already exists.
  //
  // Text side: CLAP's text tower puts the description in the SAME space as the
  // audio, so a typed moment can query the catalog directly. Previously the
  // description reached the search only after being compressed by an LLM into
  // six floats and tiled into a fake vector.

  const { data: pooledRaw } = await serviceSupabase.rpc("source_moment_embedding", {
    source_spotify_id: sourceSpotifyId,
    win_start: momentStart,
    win_end: momentEnd,
    model_id: EMBEDDING_MODEL_ID,
  });

  const audioEmbedding = parseVector(pooledRaw);

  let textEmbedding: number[] | null = null;
  if (userDescription) {
    textEmbedding = await embedText(userDescription);
  }

  let queryEmbedding: number[] | null = null;
  if (audioEmbedding && textEmbedding) {
    queryEmbedding = blendVectors(
      l2Normalize(audioEmbedding),
      textEmbedding,
      AUDIO_QUERY_WEIGHT
    );
  } else if (audioEmbedding) {
    queryEmbedding = l2Normalize(audioEmbedding);
  } else if (textEmbedding) {
    queryEmbedding = textEmbedding;
  }

  // Source-track display metadata (key/BPM/chord shown above the results).
  const { data: sourceFeatures } = await serviceSupabase
    .from("track_features")
    .select("key_name, key_mode, bpm, time_signature, segments")
    .eq("spotify_id", sourceSpotifyId)
    .single();

  const source_analysis: SourceAnalysis | null = sourceFeatures
    ? {
        key_name: sourceFeatures.key_name ?? null,
        key_mode: (sourceFeatures.key_mode as "major" | "minor" | null) ?? null,
        bpm: sourceFeatures.bpm ?? null,
        time_signature: (sourceFeatures.time_signature as 3 | 4 | null) ?? null,
        chord_label: chordAtTimestamp(
          (sourceFeatures.segments ?? []) as TrackSegment[],
          momentStart
        ),
      }
    : null;

  if (!queryEmbedding) {
    // No audio windows for this track yet and no usable description. Tell the
    // client whether analysis is in flight so it knows to poll rather than
    // rendering an empty result that reads as "nothing is similar".
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
      source_analysis,
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────

  const { data: rawMatches, error: matchError } = await serviceSupabase.rpc(
    "match_moments",
    {
      query_embedding: queryEmbedding,
      match_count: deepCut ? Math.min(limit * DEEP_CUT_CANDIDATE_MULTIPLIER, 100) : limit,
      exclude_spotify_id: sourceSpotifyId,
      model_id: EMBEDDING_MODEL_ID,
    }
  );

  if (matchError) {
    console.error("[match] match_moments RPC failed", matchError);
    return NextResponse.json({ error: "Match query failed" }, { status: 500 });
  }

  type RawMatch = {
    spotify_id: string;
    start_s: number;
    end_s: number;
    similarity: number;
  };

  const qualified = ((rawMatches ?? []) as RawMatch[]).filter(
    (m) => m.similarity >= MIN_SIMILARITY_SCORE
  );

  const cacheExpiry = () =>
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  if (qualified.length === 0) {
    // Cache the empty result so a repeat view within the TTL doesn't re-run
    // the RPC. No fabricated near-misses.
    await serviceSupabase.from("moment_matches").upsert(
      {
        moment_id: momentId,
        source_spotify_id: cacheSourceId,
        results: [],
        expires_at: cacheExpiry(),
      },
      { onConflict: "moment_id,source_spotify_id" }
    );

    return NextResponse.json({
      matches: [],
      cachedAt: null,
      analysis_pending: false,
      source_analysis,
    });
  }

  // ── Resolve metadata ──────────────────────────────────────────────────────
  //
  // Every hit is a locally-known Spotify track: only rows analyzed by our own
  // pipeline have window embeddings. The previous implementation had to
  // resolve AcousticBrainz MBIDs here via MusicBrainz + Apple Music + Spotify
  // ISRC lookups — three network round-trips per unresolved candidate, on the
  // user's critical path, silently dropping any that failed. That whole block
  // is gone.

  const matchedIds = qualified.map((m) => m.spotify_id);

  const [{ data: trackRows }, { data: featureRows }, { data: sourceTrackData }] =
    await Promise.all([
      serviceSupabase
        .from("tracks")
        .select("spotify_id, title, artist, artwork_url, preview_url, popularity, apple_music_id")
        .in("spotify_id", matchedIds),
      serviceSupabase
        .from("track_features")
        .select("spotify_id, segments, bpm, key_name, key_mode, time_signature, harmonic_rhythm")
        .in("spotify_id", matchedIds),
      serviceSupabase
        .from("tracks")
        .select("title, artist")
        .eq("spotify_id", sourceSpotifyId)
        .single(),
    ]);

  const trackMap = new Map((trackRows ?? []).map((t) => [t.spotify_id, t]));
  const featureMap = new Map((featureRows ?? []).map((f) => [f.spotify_id, f]));

  const preliminaryMatches: MomentMatch[] = qualified
    .filter((m) => trackMap.has(m.spotify_id))
    .map((m) => {
      const t = trackMap.get(m.spotify_id)!;
      const f = featureMap.get(m.spotify_id);

      return {
        spotify_id: m.spotify_id,
        title: t.title,
        artist: t.artist,
        artwork_url: t.artwork_url,
        preview_url: t.preview_url,
        // The real matched moment — this row's own window start, not the
        // first segment of the track as before.
        timestamp_s: m.start_s,
        similarity_score: m.similarity,
        claude_explanation: "",
        spotify_embed_url: `https://open.spotify.com/embed/track/${m.spotify_id}`,
        apple_music_url: t.apple_music_id
          ? `https://music.apple.com/album/${t.apple_music_id}`
          : null,
        bpm: f?.bpm ?? null,
        key_name: f?.key_name ?? null,
        key_mode: (f?.key_mode as "major" | "minor" | null) ?? null,
        time_signature: (f?.time_signature as 3 | 4 | null) ?? null,
        harmonic_rhythm: f?.harmonic_rhythm ?? null,
        // Chord sounding at the moment that matched, not at the track's start.
        chord_label: chordAtTimestamp((f?.segments ?? []) as TrackSegment[], m.start_s),
        popularity: t.popularity ?? null,
      };
    });

  // Deep Cut filtering happens before Claude runs, so explanations are only
  // generated for tracks the user will actually see.
  const sourceArtistNames = splitArtistNames(sourceTrackData?.artist ?? "");
  const filteredMatches = deepCut
    ? preliminaryMatches
        .filter((m) =>
          isDeepCutEligible({
            popularity: m.popularity,
            matchArtist: m.artist,
            sourceArtistNames,
          })
        )
        .slice(0, limit)
    : preliminaryMatches.slice(0, limit);

  // ── Explanations ──────────────────────────────────────────────────────────

  let explanations = new Map<string, string>();
  if (sourceTrackData && filteredMatches.length > 0) {
    try {
      explanations = await explainMatches({
        sourceMomentDescriptor: descriptor,
        sourceTrack: {
          title: sourceTrackData.title,
          artist: sourceTrackData.artist,
          bpm: sourceFeatures?.bpm ?? null,
          key_name: sourceFeatures?.key_name ?? null,
          key_mode: (sourceFeatures?.key_mode as "major" | "minor" | null) ?? null,
          chord_label: source_analysis?.chord_label ?? null,
          timestamp_s: momentStart,
        },
        // Top 10 only, to bound token spend.
        matches: filteredMatches.slice(0, 10).map((m) => ({
          spotify_id: m.spotify_id,
          title: m.title,
          artist: m.artist,
          similarity_score: m.similarity_score,
          timestamp_s: m.timestamp_s,
          bpm: m.bpm,
          key_name: m.key_name,
          key_mode: m.key_mode,
          chord_label: m.chord_label,
        })),
      });
    } catch {
      // Explanations are decorative — never fail the search over them.
    }
  }

  const matches: MomentMatch[] = filteredMatches.map((m) => ({
    ...m,
    claude_explanation: explanations.get(m.spotify_id) ?? "",
  }));

  await serviceSupabase.from("moment_matches").upsert(
    {
      moment_id: momentId,
      source_spotify_id: cacheSourceId,
      results: matches,
      expires_at: cacheExpiry(),
    },
    { onConflict: "moment_id,source_spotify_id" }
  );

  return NextResponse.json({
    matches,
    cachedAt: null,
    analysis_pending: false,
    source_analysis,
  });
}
