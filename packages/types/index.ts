/**
 * Splice — Shared Types
 * packages/types/index.ts
 */

// ============================================================
// Music entities
// ============================================================

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: {
    id: string;
    name: string;
    images: Array<{ url: string; width: number; height: number }>;
  };
  duration_ms: number;
  preview_url: string | null;
  external_urls: { spotify: string };
}

export interface Track {
  id: string;                  // Supabase UUID
  spotify_id: string;
  mbid: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  preview_url: string | null;
  artwork_url: string | null;
  genres: string[] | null;
}

// ============================================================
// Moment — the core product concept
// ============================================================

/**
 * MomentDescriptor
 * Claude's structured interpretation of a user's described moment.
 * All numeric fields are normalized 0.0–1.0.
 * Label fields are short human-readable strings (e.g. "high energy", "sparse texture").
 */
export interface MomentDescriptor {
  energy_profile: number;          // 0=minimal/quiet, 1=maximal/intense
  energy_profile_label: string;

  timbral_character: number;       // 0=warm/dark, 1=bright/harsh
  timbral_character_label: string;

  harmonic_tension: number;        // 0=resolved/stable, 1=unresolved/tense
  harmonic_tension_label: string;

  structural_position: number;     // 0=intro/outro, 1=peak/climax
  structural_position_label: string;

  textural_density: number;        // 0=sparse/minimal, 1=dense/layered
  textural_density_label: string;

  emotional_arc: number;           // 0=descending/melancholic, 1=ascending/euphoric
  emotional_arc_label: string;

  confidence: number;              // Claude's confidence in this interpretation, 0–1
  reasoning: string;               // One sentence explanation
}

export interface Moment {
  id: string;
  user_id: string;
  track_id: string;
  track: Track;                    // joined
  timestamp_start_s: number | null;
  timestamp_end_s: number | null;
  user_description: string | null;
  moment_descriptor: MomentDescriptor | null;
  is_public: boolean;
  is_saved: boolean;
  title: string | null;
  created_at: string;
}

// ============================================================
// Analysis
// ============================================================

export interface SegmentFeatures {
  start_s: number;
  duration_s: number;
  energy: number;
  loudness_db: number;
  spectral_centroid: number;
  chroma_vector: number[];          // 12-dim
  mfcc_means: number[];             // 13-dim
}

export interface TrackFeatures {
  spotify_id: string;
  mbid: string | null;
  source: "acousticbrainz" | "on_demand" | "synthetic";
  bpm: number;
  key_name: string;
  key_mode: "major" | "minor";
  danceability: number;
  dynamic_complexity: number;
  segments: SegmentFeatures[];
  embedding: number[];              // 128-dim
}

export type AnalysisStatus = "pending" | "processing" | "complete" | "failed";

export interface AnalysisJob {
  id: string;
  spotify_id: string;
  status: AnalysisStatus;
  error_message: string | null;
  created_at: string;
}

// ============================================================
// Match results
// ============================================================

export interface MomentMatch {
  spotify_id: string;
  title: string;
  artist: string;
  artwork_url: string | null;
  preview_url: string | null;
  timestamp_s: number;             // where in the track the matching moment occurs
  similarity_score: number;        // 0–1, cosine similarity
  claude_explanation: string;      // one-line human-readable reason for the match
  spotify_embed_url: string;       // https://open.spotify.com/embed/track/{id}
}

// ============================================================
// API request/response shapes
// ============================================================

export interface InterpretRequest {
  trackId: string;                 // Spotify track ID
  timestamp_s?: number;            // from waveform scrubber
  description?: string;            // natural language description
  trackMetadata: SpotifyTrack;
}

export interface InterpretResponse {
  descriptor: MomentDescriptor;
  momentId: string;                // Supabase UUID (saved automatically)
}

export interface AnalyzeRequest {
  spotifyId: string;
  previewUrl: string;
}

export interface AnalyzeResponse {
  status: AnalysisStatus;
  jobId: string;
}

export interface MatchRequest {
  momentId: string;
  sourceSpotifyId: string;
  limit?: number;                  // default 20
}

export interface MatchResponse {
  matches: MomentMatch[];
  cachedAt: string | null;
  /** True when the source track's audio analysis is still in progress.
   *  The client should poll /api/analyze?spotifyId={id} and retry once complete. */
  analysis_pending: boolean;
}
