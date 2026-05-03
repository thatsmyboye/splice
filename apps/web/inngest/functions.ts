/**
 * Splice — Inngest Functions
 * apps/web/inngest/functions.ts
 *
 * Background job definitions.
 * Registered in apps/web/app/api/inngest/route.ts
 */

import { inngest } from "./client";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL!;
const ANALYSIS_SERVICE_SECRET = process.env.ANALYSIS_SERVICE_SECRET!;

// ============================================================
// analysis/track.requested
// Triggered when a user requests analysis of a track not yet in track_features.
// Calls the Python analysis service, stores results in Supabase.
// ============================================================

export const analyzeTrack = inngest.createFunction(
  {
    id: "analyze-track",
    name: "Analyze Track Audio",
    retries: 3,
    throttle: {
      limit: 10,
      period: "1m",
    },
  },
  { event: "analysis/track.requested" },
  async ({ event, step }) => {
    const { spotifyId, previewUrl } = event.data as {
      spotifyId: string;
      previewUrl: string;
    };

    await step.run("mark-processing", async () => {
      await supabaseAdmin
        .from("analysis_jobs")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("spotify_id", spotifyId);
    });

    const analysis = await step.run("call-analysis-service", async () => {
      const response = await fetch(`${ANALYSIS_SERVICE_URL}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Secret": ANALYSIS_SERVICE_SECRET,
        },
        body: JSON.stringify({ preview_url: previewUrl, spotify_id: spotifyId }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Analysis service error ${response.status}: ${error}`);
      }

      return response.json();
    });

    await step.run("store-features", async () => {
      const { error } = await supabaseAdmin
        .from("track_features")
        .upsert(
          {
            spotify_id: spotifyId,
            source: "on_demand",
            analysis_version: "2.0",
            bpm: analysis.bpm,
            key_name: analysis.key_name,
            key_mode: analysis.key_mode,
            key_confidence: analysis.key_confidence ?? null,
            time_signature: analysis.time_signature ?? null,
            harmonic_rhythm: analysis.harmonic_rhythm ?? null,
            danceability: analysis.danceability,
            dynamic_complexity: analysis.dynamic_complexity,
            segments: analysis.segments,
            embedding: analysis.embedding,
            analyzed_at: new Date().toISOString(),
          },
          { onConflict: "spotify_id" }
        );

      if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    });

    await step.run("mark-complete", async () => {
      await supabaseAdmin
        .from("analysis_jobs")
        .update({ status: "complete", updated_at: new Date().toISOString() })
        .eq("spotify_id", spotifyId);
    });

    return { spotifyId, status: "complete" };
  }
);

// ============================================================
// inngest/function.failed
// Marks job as failed in DB when all retries are exhausted.
// ============================================================

export const handleAnalysisFailure = inngest.createFunction(
  { id: "handle-analysis-failure", name: "Handle Analysis Failure" },
  { event: "inngest/function.failed" },
  async ({ event }) => {
    const originalEvent = event.data.event;
    if (originalEvent.name !== "analysis/track.requested") return;

    const { spotifyId } = originalEvent.data as { spotifyId: string };

    await supabaseAdmin
      .from("analysis_jobs")
      .update({
        status: "failed",
        error_message: event.data.error?.message ?? "Unknown error",
        updated_at: new Date().toISOString(),
      })
      .eq("spotify_id", spotifyId);
  }
);
