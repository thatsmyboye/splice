/**
 * Persists an analysis-service response.
 *
 * Two destinations, deliberately separate:
 *
 *   track_features    — display metadata (key, BPM, time signature, sections,
 *                       chords). Never searched.
 *   moment_embeddings — one row per ~10s window. This is what pgvector
 *                       searches, and each row carries its own timespan, so a
 *                       hit is a real timestamp.
 *
 * Shared by the Inngest on-demand job and the bulk seed script so both write
 * the same shape — they previously duplicated the upsert and could drift.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from "./analysis-service";

export interface AnalysisWindow {
  start_s: number;
  end_s: number;
  embedding: number[];
}

export interface AnalysisResponse {
  spotify_id: string;
  duration_s: number;
  bpm: number;
  key_name: string;
  key_mode: string;
  key_confidence?: number | null;
  time_signature?: number | null;
  harmonic_rhythm?: number | null;
  danceability: number;
  dynamic_complexity: number;
  segments: unknown[];
  embedding_model: string;
  embedding_dim: number;
  windows: AnalysisWindow[];
}

/** Rows are chunked so a long upload doesn't exceed the request body limit. */
const INSERT_CHUNK_SIZE = 200;

export async function storeAnalysis(
  supabase: SupabaseClient,
  params: {
    spotifyId: string;
    /**
     * Provenance. 'upload' rows come from a full-length file the user
     * supplied, so their windows cover the whole recording; the other two are
     * preview-derived and only cover the first ~30 seconds.
     */
    source: "on_demand" | "seed" | "upload";
    analysis: AnalysisResponse;
  }
): Promise<void> {
  const { spotifyId, source, analysis } = params;

  // Refuse to store vectors from an unexpected space. Writing them would
  // silently poison the catalog — every query filters on embedding_model, so
  // mismatched rows would either be invisible or, worse, comparable-looking
  // but meaningless.
  if (analysis.embedding_model !== EMBEDDING_MODEL_ID) {
    throw new Error(
      `Embedding space mismatch: service returned "${analysis.embedding_model}", expected "${EMBEDDING_MODEL_ID}". Refusing to store.`
    );
  }
  if (analysis.embedding_dim !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dim mismatch: service returned ${analysis.embedding_dim}, expected ${EMBEDDING_DIM}. Refusing to store.`
    );
  }
  if (!analysis.windows?.length) {
    throw new Error(`Analysis for ${spotifyId} produced no windows`);
  }

  const { error: featuresError } = await supabase.from("track_features").upsert(
    {
      spotify_id: spotifyId,
      source,
      analysis_version: "3.0",
      bpm: analysis.bpm,
      key_name: analysis.key_name,
      key_mode: analysis.key_mode,
      key_confidence: analysis.key_confidence ?? null,
      time_signature: analysis.time_signature ?? null,
      harmonic_rhythm: analysis.harmonic_rhythm ?? null,
      danceability: analysis.danceability,
      dynamic_complexity: analysis.dynamic_complexity,
      segments: analysis.segments,
      // How much of the track the windows actually cover, so the UI can tell
      // the user whether a mark late in the song is inside analyzed range.
      analyzed_duration_s: analysis.duration_s,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: "spotify_id" }
  );

  if (featuresError) {
    throw new Error(`track_features upsert failed: ${featuresError.message}`);
  }

  // Replace rather than upsert: a re-analysis may use different window
  // geometry, and leftover rows from the old layout would linger forever as
  // unreachable-but-searchable junk.
  const { error: deleteError } = await supabase
    .from("moment_embeddings")
    .delete()
    .eq("spotify_id", spotifyId);

  if (deleteError) {
    throw new Error(`moment_embeddings cleanup failed: ${deleteError.message}`);
  }

  const rows = analysis.windows.map((w) => ({
    spotify_id: spotifyId,
    start_s: w.start_s,
    end_s: w.end_s,
    embedding: w.embedding,
    embedding_model: analysis.embedding_model,
  }));

  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const { error } = await supabase
      .from("moment_embeddings")
      .insert(rows.slice(i, i + INSERT_CHUNK_SIZE));

    if (error) {
      throw new Error(`moment_embeddings insert failed: ${error.message}`);
    }
  }
}
