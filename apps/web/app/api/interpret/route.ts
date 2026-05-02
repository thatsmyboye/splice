import { NextRequest, NextResponse } from "next/server";
import { interpretMoment } from "@/lib/anthropic";
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
  await serviceSupabase
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

  const { data: trackRecord } = await serviceSupabase
    .from("tracks")
    .select("id")
    .eq("spotify_id", trackId)
    .single();

  // Claude moment interpretation
  let descriptor;
  try {
    descriptor = await interpretMoment({ track, timestamp_s, timestamp_end_s, description });
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
