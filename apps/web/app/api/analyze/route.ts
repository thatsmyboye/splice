import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { getSongByISRC } from "@/lib/apple-music";
import { EMBEDDING_MODEL_ID } from "@/lib/analysis-service";
import { z } from "zod";

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * A track counts as analyzed only when it has searchable windows in the
 * CURRENT embedding space.
 *
 * Checking track_features instead would report "complete" for tracks carrying
 * metadata from an earlier embedding model — the search would then find
 * nothing for them, forever, with no job ever re-queued.
 */
async function hasSearchableWindows(
  supabase: ReturnType<typeof getServiceClient>,
  spotifyId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("moment_embeddings")
    .select("spotify_id")
    .eq("spotify_id", spotifyId)
    .eq("embedding_model", EMBEDDING_MODEL_ID)
    .limit(1)
    .maybeSingle();

  return !!data;
}

export async function GET(request: NextRequest) {
  const spotifyId = request.nextUrl.searchParams.get("spotifyId");
  if (!spotifyId) {
    return NextResponse.json({ error: "Missing spotifyId" }, { status: 400 });
  }

  const serviceSupabase = getServiceClient();

  if (await hasSearchableWindows(serviceSupabase, spotifyId)) {
    return NextResponse.json({ status: "complete", jobId: null });
  }

  const { data: job } = await serviceSupabase
    .from("analysis_jobs")
    .select("id, status, error_message")
    .eq("spotify_id", spotifyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!job) {
    return NextResponse.json({ status: "not_started", jobId: null });
  }

  return NextResponse.json({ status: job.status, jobId: job.id, error: job.error_message });
}

const RequestSchema = z.object({
  spotifyId: z.string().min(1),
  // previewUrl is optional — when absent or null we attempt Apple Music fallback
  previewUrl: z.string().url().nullable().optional(),
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

  const { spotifyId } = parsed.data;
  let previewUrl = parsed.data.previewUrl ?? null;

  const serviceSupabase = getServiceClient();

  if (await hasSearchableWindows(serviceSupabase, spotifyId)) {
    return NextResponse.json({ status: "complete", jobId: null });
  }

  // When Spotify preview URL is absent, attempt Apple Music fallback via ISRC.
  // ~10-20% of Spotify tracks have null preview_url; Apple Music often has a preview
  // for the same recording that works with the librosa analysis pipeline.
  if (!previewUrl) {
    const { data: trackRow } = await serviceSupabase
      .from("tracks")
      .select("isrc")
      .eq("spotify_id", spotifyId)
      .single();

    if (trackRow?.isrc) {
      const amSong = await getSongByISRC(trackRow.isrc);
      const amPreview = amSong?.attributes.previews?.[0]?.url ?? null;
      if (amPreview) {
        previewUrl = amPreview;
        console.info(`[analyze] Using Apple Music preview for ${spotifyId} (ISRC: ${trackRow.isrc})`);
      }
    }
  }

  if (!previewUrl) {
    return NextResponse.json(
      { error: "No preview URL available for this track" },
      { status: 422 }
    );
  }

  // Already queued
  const { data: existingJob } = await serviceSupabase
    .from("analysis_jobs")
    .select("id, status")
    .eq("spotify_id", spotifyId)
    .in("status", ["pending", "processing"])
    .single();

  if (existingJob) {
    return NextResponse.json({
      status: existingJob.status,
      jobId: existingJob.id,
    });
  }

  // Create job record
  const { data: job } = await serviceSupabase
    .from("analysis_jobs")
    .insert({ spotify_id: spotifyId, status: "pending" })
    .select("id")
    .single();

  // Fire Inngest event — non-fatal if Inngest is not configured (e.g. missing key).
  try {
    await inngest.send({
      name: "analysis/track.requested",
      data: { spotifyId, previewUrl },
    });
  } catch (err) {
    console.warn(
      "[analyze] Inngest send failed — job queued in DB but event not fired:",
      err instanceof Error ? err.message : err
    );
  }

  return NextResponse.json({ status: "pending", jobId: job?.id ?? null });
}
