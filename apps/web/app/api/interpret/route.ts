import { NextRequest, NextResponse } from "next/server";
import { interpretMoment } from "@/lib/anthropic";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { getTrack } from "@/lib/spotify";
import { z } from "zod";

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

  const { trackId, timestamp_s, description, trackMetadata } = parsed.data;

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
    descriptor = await interpretMoment({ track, timestamp_s, description });
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

  return NextResponse.json({ descriptor, momentId: moment.id });
}
