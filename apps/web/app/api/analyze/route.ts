import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { z } from "zod";

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET(request: NextRequest) {
  const spotifyId = request.nextUrl.searchParams.get("spotifyId");
  if (!spotifyId) {
    return NextResponse.json({ error: "Missing spotifyId" }, { status: 400 });
  }

  const serviceSupabase = getServiceClient();

  // Synthetic embeddings are placeholders — only real analysis counts as complete.
  const { data: existing } = await serviceSupabase
    .from("track_features")
    .select("spotify_id, source")
    .eq("spotify_id", spotifyId)
    .neq("source", "synthetic")
    .single();

  if (existing) {
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
  previewUrl: z.string().url(),
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

  const { spotifyId, previewUrl } = parsed.data;
  const serviceSupabase = getServiceClient();

  // Synthetic embeddings are placeholders — only real analysis counts as complete.
  const { data: existing } = await serviceSupabase
    .from("track_features")
    .select("spotify_id, source")
    .eq("spotify_id", spotifyId)
    .neq("source", "synthetic")
    .single();

  if (existing) {
    return NextResponse.json({ status: "complete", jobId: null });
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
