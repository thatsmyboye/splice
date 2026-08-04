/**
 * Splice — Inngest Functions
 * apps/web/inngest/functions.ts
 *
 * Background job definitions.
 * Registered in apps/web/app/api/inngest/route.ts
 */

import { inngest } from "./client";
import { createClient } from "@supabase/supabase-js";
import { getChartTracks } from "@/lib/apple-music";
import { searchTracks } from "@/lib/spotify";
import { storeAnalysis, type AnalysisResponse } from "@/lib/store-analysis";

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
      await storeAnalysis(supabaseAdmin, {
        spotifyId,
        source: "on_demand",
        analysis: analysis as AnalysisResponse,
      });
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
// analysis/charts.sync  (daily cron)
// Fetches the Apple Music top-100 chart, resolves each track to
// a Spotify ID via title+artist search, and queues audio analysis
// for tracks not yet in the corpus. This keeps the vector catalog
// current with what users are likely to search.
// ============================================================

export const syncChartTracks = inngest.createFunction(
  {
    id: "sync-chart-tracks",
    name: "Sync Apple Music Chart Tracks",
    // Throttle to avoid hammering Spotify search in a burst
    throttle: { limit: 20, period: "1m" },
  },
  // Run at 03:00 UTC daily — low-traffic window
  { cron: "0 3 * * *" },
  async ({ step }) => {
    const chartSongs = await step.run("fetch-apple-music-charts", async () => {
      return getChartTracks("us", 100);
    });

    if (chartSongs.length === 0) {
      return { skipped: true, reason: "Apple Music charts unavailable or not configured" };
    }

    let queued = 0;
    let alreadyIndexed = 0;
    let noPreview = 0;

    for (const song of chartSongs) {
      const { id: amId, attributes: attrs } = song;

      const result = await step.run(`process-chart-track-${amId}`, async () => {
        // Resolve to a Spotify track via title + artist search
        const spotifyResults = await searchTracks(
          `${attrs.name} ${attrs.artistName}`,
          1
        ).catch(() => []);

        if (spotifyResults.length === 0) return { outcome: "no_spotify_match" };

        const spotifyTrack = spotifyResults[0];
        const spotifyId: string = spotifyTrack.id;
        const previewUrl: string | null = spotifyTrack.preview_url ?? null;

        // Check if already indexed with real analysis
        const { data: existing } = await supabaseAdmin
          .from("track_features")
          .select("spotify_id, source")
          .eq("spotify_id", spotifyId)
          .neq("source", "synthetic")
          .single();

        if (existing) return { outcome: "already_indexed" };

        // Check if already queued
        const { data: existingJob } = await supabaseAdmin
          .from("analysis_jobs")
          .select("id")
          .eq("spotify_id", spotifyId)
          .in("status", ["pending", "processing"])
          .single();

        if (existingJob) return { outcome: "already_queued" };

        // Fall back to Apple Music preview if Spotify has none
        const effectivePreviewUrl = previewUrl ?? attrs.previews?.[0]?.url ?? null;
        if (!effectivePreviewUrl) return { outcome: "no_preview" };

        // Upsert minimal track metadata so the track is identifiable in results
        await supabaseAdmin.from("tracks").upsert(
          {
            spotify_id: spotifyId,
            title: spotifyTrack.name,
            artist: spotifyTrack.artists
              .map((a: { name: string }) => a.name)
              .join(", "),
            album: spotifyTrack.album?.name ?? null,
            duration_ms: spotifyTrack.duration_ms ?? null,
            preview_url: previewUrl,
            artwork_url: spotifyTrack.album?.images?.[0]?.url ?? null,
            popularity: spotifyTrack.popularity ?? null,
            isrc: attrs.isrc ?? null,
            apple_music_id: amId,
            genres: attrs.genreNames?.length ? attrs.genreNames : null,
          },
          { onConflict: "spotify_id" }
        );

        // Queue analysis job
        const { data: job } = await supabaseAdmin
          .from("analysis_jobs")
          .insert({ spotify_id: spotifyId, status: "pending" })
          .select("id")
          .single();

        await inngest.send({
          name: "analysis/track.requested",
          data: { spotifyId, previewUrl: effectivePreviewUrl },
        });

        return { outcome: "queued", jobId: job?.id };
      });

      if (result.outcome === "already_indexed") alreadyIndexed++;
      else if (result.outcome === "queued") queued++;
      else if (result.outcome === "no_preview") noPreview++;
    }

    return {
      chartSize: chartSongs.length,
      queued,
      alreadyIndexed,
      noPreview,
    };
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
