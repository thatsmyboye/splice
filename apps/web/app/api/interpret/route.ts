import { NextRequest, NextResponse } from "next/server";
import { interpretMoment } from "@/lib/anthropic";
import type { HarmonicContext } from "@/lib/anthropic";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { getTrack } from "@/lib/spotify";
import { getSongByISRC } from "@/lib/apple-music";
import { z } from "zod";
import { segmentAtTimestamp, type TrackSegment } from "@/lib/segments";

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

  // Extract ISRC from Spotify track object (present on /tracks/{id} responses)
  const isrc: string | null = (track.external_ids?.isrc as string | undefined) ?? null;

  // Enrich with Apple Music: resolve genres and Apple Music catalog ID via ISRC.
  // This is non-blocking — failures are silently skipped so Spotify-only setups work.
  let appleMusicId: string | null = null;
  let genres: string[] | null = null;

  if (isrc) {
    const amSong = await getSongByISRC(isrc);
    if (amSong) {
      appleMusicId = amSong.id;
      genres = amSong.attributes.genreNames.length > 0
        ? amSong.attributes.genreNames
        : null;
    }
  }

  const serviceSupabase = getServiceClient();

  // Upsert track record so we have a FK for the moment.
  // Store isrc and apple_music_id now so subsequent match lookups can use them
  // without needing a second Apple Music call.
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
        popularity: track.popularity ?? null,
        isrc,
        apple_music_id: appleMusicId,
        genres,
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
      const segs = (existingAnalysis.segments ?? []) as TrackSegment[];
      let segChord: string | undefined;
      let segChordConf: number | undefined;
      if (timestamp_s !== undefined) {
        const matchSeg = segmentAtTimestamp(segs, timestamp_s);
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

  // Claude moment interpretation — pass Apple Music genres when available
  let descriptor;
  try {
    descriptor = await interpretMoment({
      track,
      timestamp_s,
      timestamp_end_s,
      description,
      genres: genres ?? undefined,
      harmonicContext,
    });
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

  // NOTE: this route used to insert a "synthetic" track_features row here —
  // the descriptor's 6 scores tiled 21x to fill a 128-dim vector — so the track
  // would be "immediately searchable" before the analysis service had run.
  //
  // That was actively harmful. The tiled vector shares no space with the real
  // librosa/essentia embeddings, but /api/match read it as the query vector
  // anyway, so every search ran on a meaningless query and the results were
  // noise. Real analysis is now the only path to a searchable embedding; until
  // it completes, /api/match honestly reports analysis_pending.

  return NextResponse.json({ descriptor, momentId: moment.id });
}
