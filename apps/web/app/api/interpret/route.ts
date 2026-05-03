import { NextRequest, NextResponse } from "next/server";
import { interpretMoment } from "@/lib/anthropic";
import type { HarmonicContext } from "@/lib/anthropic";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { getTrack } from "@/lib/spotify";
import { z } from "zod";
import type { MomentDescriptor } from "@splice/types";

/**
 * Converts a MomentDescriptor's 6 normalized scores into a 128-dim unit vector
 * usable for pgvector cosine similarity matching.
 * Tracks described with similar moment qualities will get similar embeddings.
 */
function descriptorToEmbedding(d: MomentDescriptor): number[] {
  const v = [
    d.energy_profile,
    d.timbral_character,
    d.harmonic_tension,
    d.structural_position,
    d.textural_density,
    d.emotional_arc,
  ];
  const e = Array.from({ length: 128 }, (_, i) => v[i % 6]);
  const mag = Math.sqrt(e.reduce((s, x) => s + x * x, 0));
  return mag > 0 ? e.map((x) => x / mag) : e;
}

// Service role client bypasses RLS for transient moment creation
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

const RequestSchema = z.object({
  trackId: z.string().min(1),
  timestamp_s: z.number().min(0).optional(),
  timestamp_end_s: z.number().min(0).optional(),
  description: z.string().min(1).optional(),
  trackMetadata: z.unknown().optional(),
});

export async function POST(request: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  const { trackId, timestamp_s, timestamp_end_s, description, trackMetadata } = parsed.data;

  if (timestamp_s === undefined && !description) {
    return NextResponse.json(
      { error: "timestamp_s or description is required" },
      { status: 400 }
    );
  }

  // Use provided metadata or fetch from Spotify
  let track = trackMetadata as any;
  if (!track) {
    try {
      track = await getTrack(trackId);
    } catch {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }
  }

  const serviceSupabase = getServiceClient();

  // Upsert track record so we have a FK for the moment
  const { error: upsertError } = await serviceSupabase
    .from("tracks")
    .upsert(
      {
        spotify_id: trackId,
        title: track.name,
        artist: track.artists
          .map((a: { name: string }) => a.name)
          .join(", "),
        album: track.album.name,
        duration_ms: track.duration_ms,
        preview_url: track.preview_url ?? null,
        artwork_url: track.album.images[0]?.url ?? null,
      },
      { onConflict: "spotify_id" }
    );

  if (upsertError) {
    const status = (upsertError as { status?: number }).status ?? 500;
    if (status >= 500) {
      console.error("[interpret] tracks upsert failed (service error)", upsertError);
      return NextResponse.json(
        { error: "Service temporarily unavailable — please try again" },
        { status: 503 }
      );
    }
    console.error("[interpret] tracks upsert failed", upsertError);
  }

  const { data: trackRecord } = await serviceSupabase
    .from("tracks")
    .select("id")
    .eq("spotify_id", trackId)
    .single();

  // Fetch harmonic context from existing v2.0 analysis (non-blocking, skip on error)
  let harmonicContext: HarmonicContext | undefined;
  try {
    const { data: existingAnalysis } = await serviceSupabase
      .from("track_features")
      .select("key_name, key_mode, key_confidence, time_signature, harmonic_rhythm, segments, analysis_version")
      .eq("spotify_id", trackId)
      .neq("source", "synthetic")
      .single();

    if (existingAnalysis?.analysis_version === "2.0" && existingAnalysis.key_name) {
      type SegRow = { start_s: number; chord_label?: string; chord_confidence?: number };
      const segs = (existingAnalysis.segments ?? []) as SegRow[];
      let segChord: string | undefined;
      let segChordConf: number | undefined;
      if (timestamp_s !== undefined) {
        const matchSeg = segs.filter((s) => s.start_s <= timestamp_s).pop();
        segChord = matchSeg?.chord_label;
        segChordConf = matchSeg?.chord_confidence;
      }
      harmonicContext = {
        key_name: existingAnalysis.key_name,
        key_mode: existingAnalysis.key_mode,
        key_confidence: existingAnalysis.key_confidence ?? 0.5,
        time_signature: existingAnalysis.time_signature ?? null,
        harmonic_rhythm: existingAnalysis.harmonic_rhythm ?? null,
        segment_chord: segChord,
        segment_chord_confidence: segChordConf,
      };
    }
  } catch {
    // Non-fatal: proceed without harmonic context
  }

  // Claude moment interpretation
  let descriptor;
  try {
    descriptor = await interpretMoment({ track, timestamp_s, timestamp_end_s, description, harmonicContext });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Moment interpretation failed",
      },
      { status: 500 }
    );
  }

  // Save moment (user_id is nullable for anonymous users)
  const { data: moment, error: momentError } = await serviceSupabase
    .from("moments")
    .insert({
      user_id: user?.id ?? null,
      track_id: trackRecord?.id ?? null,
      timestamp_start_s: timestamp_s ?? null,
      timestamp_end_s: timestamp_end_s ?? null,
      user_description: description ?? null,
      moment_descriptor: descriptor,
      is_saved: false,
    })
    .select("id")
    .single();

  if (momentError || !moment) {
    const status = (momentError as { status?: number } | null)?.status ?? 500;
    console.error("[interpret] moments insert failed", momentError);
    if (status >= 500) {
      return NextResponse.json(
        { error: "Service temporarily unavailable — please try again" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Failed to save moment" },
      { status: 500 }
    );
  }

  // Store a synthetic embedding derived from the Claude descriptor so this track
  // is immediately searchable by the vector catalog — even before the Python
  // analysis service has run. Only inserted when no real analysis exists yet;
  // on_demand/acousticbrainz entries are left untouched.
  const { data: existingFeatures } = await serviceSupabase
    .from("track_features")
    .select("spotify_id, source")
    .eq("spotify_id", trackId)
    .single();

  if (!existingFeatures) {
    const syntheticEmbedding = descriptorToEmbedding(descriptor);
    await serviceSupabase.from("track_features").insert({
      spotify_id: trackId,
      source: "synthetic",
      analysis_version: "1.0",
      segments: null,
      bpm: null,
      key_name: null,
      key_mode: null,
      danceability: null,
      dynamic_complexity: null,
      embedding: syntheticEmbedding,
      analyzed_at: new Date().toISOString(),
    });
  }

  return NextResponse.json({ descriptor, momentId: moment.id });
}
