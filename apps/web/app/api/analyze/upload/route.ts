import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { storeAnalysis, type AnalysisResponse } from "@/lib/store-analysis";

/**
 * Full-track analysis from a user-supplied audio file.
 *
 * Why this exists: a Spotify/Apple preview is 30 seconds, but the discover
 * timeline lets the user mark a moment anywhere in a song. A mark at 3:40 of a
 * five-minute track could never correspond to the audio that was analyzed —
 * the timestamp the user chose and the audio the embeddings came from were
 * different things. Supplying the real file removes that mismatch, and it's
 * the user's own copy so there's no licensing question.
 *
 * The bytes are streamed straight through to the analysis service and never
 * persisted — not to disk, not to object storage. Only the derived embeddings
 * and feature metadata are kept.
 */

// Analysis of a full-length track is materially slower than a 30s preview:
// roughly a window per 5 seconds of audio, each needing a CLAP forward pass,
// plus the librosa/essentia pass over the whole file.
export const maxDuration = 300;

// A 10-minute track at 320kbps is ~24MB. This bounds it with headroom while
// still rejecting obviously wrong uploads (video files, lossless albums).
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const ACCEPTED_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
];

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(request: NextRequest) {
  const serviceUrl = process.env.ANALYSIS_SERVICE_URL;
  const serviceSecret = process.env.ANALYSIS_SERVICE_SECRET;

  if (!serviceUrl || !serviceSecret) {
    return NextResponse.json(
      { error: "Analysis service is not configured" },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = form.get("file");
  const spotifyId = form.get("spotifyId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
  }
  if (typeof spotifyId !== "string" || !spotifyId.trim()) {
    return NextResponse.json({ error: "Missing spotifyId" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Audio file is empty" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${
          MAX_UPLOAD_BYTES / 1024 / 1024
        }MB`,
      },
      { status: 413 }
    );
  }

  // Browsers occasionally report an empty type for files dragged from some
  // filesystems, so an unknown type is allowed through — the decoder is the
  // real arbiter of whether the bytes are audio.
  if (file.type && !ACCEPTED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `Unsupported audio format: ${file.type}` },
      { status: 415 }
    );
  }

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name || "upload");
  upstreamForm.append("spotify_id", spotifyId);

  let upstream: Response;
  try {
    upstream = await fetch(`${serviceUrl}/analyze-upload`, {
      method: "POST",
      headers: { "X-Service-Secret": serviceSecret },
      body: upstreamForm,
      signal: AbortSignal.timeout(280_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.error("[analyze/upload] analysis service unreachable", err);
    return NextResponse.json(
      {
        error: timedOut
          ? "Analysis timed out. Try a shorter file."
          : "Could not reach the analysis service",
      },
      { status: timedOut ? 504 : 502 }
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error(`[analyze/upload] service returned ${upstream.status}: ${detail}`);
    // 413/415/422 are the user's problem to fix (wrong file); surface them.
    // Anything else is ours, and shouldn't leak internals.
    const passThrough = [413, 415, 422].includes(upstream.status);
    return NextResponse.json(
      { error: passThrough ? detail || "Audio could not be analyzed" : "Analysis failed" },
      { status: passThrough ? upstream.status : 502 }
    );
  }

  const analysis = (await upstream.json()) as AnalysisResponse;

  try {
    await storeAnalysis(getServiceClient(), {
      spotifyId,
      source: "upload",
      analysis,
    });
  } catch (err) {
    console.error("[analyze/upload] storing analysis failed", err);
    return NextResponse.json(
      { error: "Analysis succeeded but could not be saved" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: "complete",
    duration_s: analysis.duration_s,
    windows: analysis.windows.length,
  });
}
