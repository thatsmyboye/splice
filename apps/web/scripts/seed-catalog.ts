/**
 * Bulk-seed the track_features catalog using the SAME on-demand analysis
 * pipeline that serves live user searches, instead of the AcousticBrainz
 * import (deprecated -- see services/analysis/README.md).
 *
 * Why this exists: AcousticBrainz's low-level data is track-level aggregates
 * only (no real segment boundaries), and its 128-dim embedding layout is
 * structurally different from services/analysis/main.py's build_embedding().
 * The two are not comparable by cosine similarity. This script instead
 * builds day-one catalog coverage by running a genre/era-diverse seed list
 * through services/analysis's real /analyze endpoint -- the exact same call
 * apps/web/inngest/functions.ts makes for a live user search -- so every row
 * in the catalog (seed or organic) lives in one embedding space with genuine
 * per-segment (moment-level) features from the start.
 *
 * DOES NOT run automatically and is not wired into any cron/build step.
 * Run manually, on purpose, when you're ready to pay for it.
 *
 * Usage (from apps/web/):
 *   pnpm seed:catalog --dry-run                    # read-only estimate, no writes, no /analyze calls
 *   pnpm seed:catalog --dry-run --limit 200         # smaller estimate for a quick sanity check
 *   pnpm seed:catalog --concurrency 16              # the real run (NOT executed by this session)
 *
 * Flags:
 *   --dry-run              Resolve candidates and report counts/estimate only. No writes, no /analyze calls.
 *   --limit N               Cap the candidate pool to N tracks (applied after dedup, before resolution).
 *   --concurrency N         Max concurrent /analyze calls during a real run (default 16, matching --workers in services/analysis's Dockerfile).
 *   --avg-latency-s N       Seconds-per-track assumption used for the dry-run time estimate (default 6).
 *   --storefronts a,b,c     Apple Music storefronts to pull charts from (default: a diverse preset list).
 *
 * Requires apps/web/.env.local to be populated: NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, SPOTIFY_CLIENT_ID/SECRET, APPLE_MUSIC_* (optional
 * but improves preview-URL coverage), ANALYSIS_SERVICE_URL/SECRET.
 *
 * Safe to interrupt and re-run: already-analyzed tracks (source != 'synthetic')
 * are skipped, matching the same idempotency guarantee as import_acousticbrainz.py.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "path";
loadEnv({ path: resolve(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";
import { searchTracks } from "../lib/spotify";
import { getSongByISRC, getChartTracks } from "../lib/apple-music";
import { storeAnalysis, type AnalysisResponse } from "../lib/store-analysis";
import { EMBEDDING_MODEL_ID } from "../lib/analysis-service";
import { CURATED_SEED_TRACKS, type SeedCandidate } from "./seed-tracklist";

// Broad, deliberately non-overlapping regional spread -- diversity here is a
// proxy for genre diversity, since a country's own top-100 chart differs far
// more from another region's than "top overall" within one English-speaking
// market ever would. Combined with CURATED_SEED_TRACKS (which covers genres
// no chart will ever surface, e.g. classical/jazz/doom metal/qawwali), this
// is the two-lever approach to hitting real breadth rather than just volume.
const DEFAULT_STOREFRONTS = [
  // Americas
  "us", "ca", "mx", "br", "ar", "co", "cl",
  // Europe
  "gb", "de", "fr", "es", "it", "se", "no", "pl", "tr", "gr", "pt", "nl",
  // Middle East / North Africa
  "ae", "sa", "eg", "il",
  // Sub-Saharan Africa
  "ng", "za", "ke", "gh",
  // South Asia
  "in", "pk", "bd", "lk",
  // East / Southeast Asia
  "jp", "kr", "tw", "hk", "th", "vn", "id", "ph", "my", "sg",
  // Oceania
  "au", "nz",
];
// The analysis service now runs a SINGLE uvicorn worker (the CLAP checkpoint is
// ~2GB resident) and bounds real parallelism internally via ANALYSIS_CONCURRENCY.
// Sending more than that just queues at the service, so this default tracks the
// service-side semaphore rather than a worker count. Raise both together.
const DEFAULT_CONCURRENCY = 4;
// CLAP inference on top of the librosa/essentia pass; slower than the previous
// DSP-only pipeline. Re-measure against a real deploy before trusting estimates.
const DEFAULT_AVG_LATENCY_S = 12;

interface Args {
  dryRun: boolean;
  limit: number | null;
  concurrency: number;
  avgLatencyS: number;
  storefronts: string[];
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    limit: get("--limit") ? parseInt(get("--limit")!, 10) : null,
    concurrency: get("--concurrency") ? parseInt(get("--concurrency")!, 10) : DEFAULT_CONCURRENCY,
    avgLatencyS: get("--avg-latency-s") ? parseFloat(get("--avg-latency-s")!) : DEFAULT_AVG_LATENCY_S,
    storefronts: get("--storefronts")?.split(",").map((s) => s.trim()) ?? DEFAULT_STOREFRONTS,
  };
}

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function dedupeCandidates(candidates: SeedCandidate[]): SeedCandidate[] {
  const seen = new Set<string>();
  const out: SeedCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.title.trim().toLowerCase()}|${c.artist.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Pull Apple Music top-songs charts across storefronts for genre/geographic breadth. */
async function fetchChartCandidates(storefronts: string[]): Promise<SeedCandidate[]> {
  const out: SeedCandidate[] = [];
  for (const storefront of storefronts) {
    try {
      const songs = await getChartTracks(storefront, 100);
      for (const song of songs) {
        out.push({
          title: song.attributes.name,
          artist: song.attributes.artistName,
          genre: `chart:${storefront}`,
        });
      }
    } catch (err) {
      console.warn(`[seed] chart fetch failed for storefront ${storefront}:`, err);
    }
  }
  return out;
}

interface ResolvedCandidate {
  spotifyId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  artworkUrl: string | null;
  popularity: number | null;
  isrc: string | null;
  previewUrl: string | null;
  genre: string;
}

type ResolveOutcome =
  | { kind: "resolved"; candidate: ResolvedCandidate }
  | { kind: "no-match" } // Spotify genuinely returned zero results
  | { kind: "error"; message: string }; // the search call itself failed (rate limit, network, etc.)

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const MAX_SEARCH_RETRIES = 4;

/**
 * Search Spotify with retry/backoff on rate-limit (429) responses.
 * searchTracks() throws `Spotify search failed: ${status}` on any non-2xx,
 * so we detect 429 via the message rather than needing spotify.ts to expose
 * a richer error type.
 */
async function searchWithRetry(query: string): Promise<{ results: any[] } | { error: string }> {
  for (let attempt = 0; attempt <= MAX_SEARCH_RETRIES; attempt++) {
    try {
      const results = await searchTracks(query, 1);
      return { results: results ?? [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimited = message.includes("429");
      if (isRateLimited && attempt < MAX_SEARCH_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
        await sleep(backoffMs);
        continue;
      }
      return { error: message };
    }
  }
  return { error: "exhausted retries" };
}

/** Resolve a {title, artist} pair to Spotify metadata + the best available preview URL. */
async function resolveCandidate(candidate: SeedCandidate): Promise<ResolveOutcome> {
  const outcome = await searchWithRetry(`${candidate.title} ${candidate.artist}`);
  if ("error" in outcome) return { kind: "error", message: outcome.error };
  if (outcome.results.length === 0) return { kind: "no-match" };

  const t = outcome.results[0];
  const isrc: string | null = t.external_ids?.isrc ?? null;
  let previewUrl: string | null = t.preview_url ?? null;

  if (!previewUrl && isrc) {
    const amSong = await getSongByISRC(isrc).catch(() => null);
    previewUrl = amSong?.attributes.previews?.[0]?.url ?? null;
  }

  return {
    kind: "resolved",
    candidate: {
      spotifyId: t.id,
      title: t.name,
      artist: t.artists.map((a: { name: string }) => a.name).join(", "),
      album: t.album?.name ?? null,
      durationMs: t.duration_ms ?? null,
      artworkUrl: t.album?.images?.[0]?.url ?? null,
      popularity: t.popularity ?? null,
      isrc,
      previewUrl,
      genre: candidate.genre,
    },
  };
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    const i = index++;
    if (i >= items.length) return;
    await worker(items[i]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

async function analyzeAndStore(
  supabase: ReturnType<typeof getServiceClient>,
  candidate: ResolvedCandidate
): Promise<void> {
  const serviceUrl = process.env.ANALYSIS_SERVICE_URL;
  const serviceSecret = process.env.ANALYSIS_SERVICE_SECRET;
  if (!serviceUrl || !serviceSecret) {
    throw new Error("ANALYSIS_SERVICE_URL / ANALYSIS_SERVICE_SECRET not configured");
  }

  await supabase.from("tracks").upsert(
    {
      spotify_id: candidate.spotifyId,
      title: candidate.title,
      artist: candidate.artist,
      album: candidate.album,
      duration_ms: candidate.durationMs,
      preview_url: candidate.previewUrl,
      artwork_url: candidate.artworkUrl,
      popularity: candidate.popularity,
      isrc: candidate.isrc,
    },
    { onConflict: "spotify_id" }
  );

  const res = await fetch(`${serviceUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Service-Secret": serviceSecret },
    body: JSON.stringify({ preview_url: candidate.previewUrl, spotify_id: candidate.spotifyId }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`analysis service returned ${res.status}: ${await res.text()}`);
  }

  await storeAnalysis(supabase, {
    spotifyId: candidate.spotifyId,
    source: "seed",
    analysis: (await res.json()) as AnalysisResponse,
  });
}

interface Stats {
  candidatePool: number;
  noSpotifyMatch: number;
  resolutionErrors: number; // search call itself failed (rate limit, network, etc.) -- NOT the same as "doesn't exist on Spotify"
  alreadyAnalyzed: number;
  noPreview: number;
  toAnalyze: number;
  analyzed: number;
  failed: number;
}

function printEstimate(stats: Stats, args: Args): void {
  const seconds = Math.ceil(stats.toAnalyze / args.concurrency) * args.avgLatencyS;
  const hours = (seconds / 3600).toFixed(1);
  const cpuSeconds = stats.toAnalyze * args.avgLatencyS;
  const cpuHours = (cpuSeconds / 3600).toFixed(1);
  const bandwidthGB = ((stats.toAnalyze * 0.6) / 1024).toFixed(2); // ~600KB avg 30s preview

  console.log("\n=== DRY RUN ESTIMATE (no writes, no /analyze calls were made) ===");
  console.log(`Candidate pool (deduped):     ${stats.candidatePool}`);
  console.log(`  no Spotify match:           ${stats.noSpotifyMatch}`);
  console.log(`  resolution errors (retry-exhausted, NOT "no match" -- rerun to pick these back up): ${stats.resolutionErrors}`);
  console.log(`  already analyzed (skip):    ${stats.alreadyAnalyzed}`);
  console.log(`  no preview URL available:   ${stats.noPreview}`);
  console.log(`  --> would analyze:          ${stats.toAnalyze}`);
  console.log("");
  console.log(`Assumptions: concurrency=${args.concurrency}, avg ${args.avgLatencyS}s/track (services/analysis docs cite 3-8s per 30s preview)`);
  console.log(`Estimated wall-clock time:    ~${hours}h (${seconds}s)`);
  console.log(`Estimated analysis compute:   ~${cpuHours} CPU-hours on the Railway analysis service`);
  console.log(`Estimated audio bandwidth:    ~${bandwidthGB} GB fetched by the analysis service`);
  console.log("");
  console.log("Cost notes:");
  console.log("  - Anthropic/Claude: $0 -- this pipeline is pure librosa/essentia DSP, no LLM calls.");
  console.log("  - Spotify search: $0 -- Client Credentials flow, generous rate limits.");
  console.log("  - Apple Music: $0 marginal, assuming Developer Program membership is already active.");
  console.log("  - Supabase: negligible -- a few thousand row upserts + small vector storage.");
  console.log("  - Railway: the real cost driver. Depends on your plan/instance size -- higher");
  console.log("    concurrency finishes faster but risks CPU contention on a single small instance");
  console.log("    (librosa/essentia are CPU-bound per request). Re-run with real credentials to");
  console.log("    replace these assumptions with actual candidate-pool numbers before committing.");
  console.log("===================================================================\n");
}

function printFinalReport(stats: Stats): void {
  console.log("\n=== SEED RUN COMPLETE ===");
  console.log(`Analyzed successfully:  ${stats.analyzed}`);
  console.log(`Failed:                 ${stats.failed}`);
  console.log(`Skipped (already done): ${stats.alreadyAnalyzed}`);
  console.log(`Skipped (no preview):   ${stats.noPreview}`);
  console.log(`Skipped (no match):     ${stats.noSpotifyMatch}`);
  console.log(`Resolution errors:      ${stats.resolutionErrors} (rerun to retry these -- not the same as "no match")`);
  console.log("==========================\n");
}

// Fixed pacing gap between sequential Spotify search calls. Spotify's
// Client Credentials rate limit isn't officially published, but hammering
// ~2,700 candidates with zero delay reliably triggers 429s partway through
// a real run -- this keeps us comfortably under it.
const SEARCH_PACING_MS = 120;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getServiceClient();

  console.log(`[seed] Fetching Apple Music charts across ${args.storefronts.length} storefronts...`);
  const chartCandidates = await fetchChartCandidates(args.storefronts);
  console.log(`[seed] ${chartCandidates.length} chart candidates, ${CURATED_SEED_TRACKS.length} curated candidates`);

  let candidates = dedupeCandidates([...CURATED_SEED_TRACKS, ...chartCandidates]);
  if (args.limit) candidates = candidates.slice(0, args.limit);

  const stats: Stats = {
    candidatePool: candidates.length,
    noSpotifyMatch: 0,
    resolutionErrors: 0,
    alreadyAnalyzed: 0,
    noPreview: 0,
    toAnalyze: 0,
    analyzed: 0,
    failed: 0,
  };

  const toProcess: ResolvedCandidate[] = [];
  const errorSamples: string[] = [];

  const PROGRESS_EVERY = 50;
  const startedAt = Date.now();
  console.log(`[seed] Resolving ${candidates.length} candidates against Spotify (read-only, paced ${SEARCH_PACING_MS}ms apart)...`);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const outcome = await resolveCandidate(candidate);
    await sleep(SEARCH_PACING_MS);

    if (outcome.kind === "error") {
      stats.resolutionErrors++;
      if (errorSamples.length < 5 && !errorSamples.includes(outcome.message)) {
        errorSamples.push(outcome.message);
      }
    } else if (outcome.kind === "no-match") {
      stats.noSpotifyMatch++;
    } else {
      const resolved = outcome.candidate;

      // "Already analyzed" means it has searchable windows in the CURRENT
      // embedding space. Checking track_features instead would skip tracks
      // carrying stale metadata from a previous embedding model, leaving them
      // permanently unsearchable.
      const { data: existing } = await supabase
        .from("moment_embeddings")
        .select("spotify_id")
        .eq("spotify_id", resolved.spotifyId)
        .eq("embedding_model", EMBEDDING_MODEL_ID)
        .limit(1)
        .maybeSingle();

      if (existing) {
        stats.alreadyAnalyzed++;
      } else if (!resolved.previewUrl) {
        stats.noPreview++;
      } else {
        stats.toAnalyze++;
        toProcess.push(resolved);
      }
    }

    if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === candidates.length) {
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(
        `[seed] ...${i + 1}/${candidates.length} resolved (${elapsedS}s elapsed, ` +
          `${stats.toAnalyze} analyzable, ${stats.resolutionErrors} errors so far)`
      );
    }
  }

  if (errorSamples.length > 0) {
    console.log(`\n[seed] Sample resolution errors (${stats.resolutionErrors} total, retry-exhausted):`);
    errorSamples.forEach((e) => console.log(`  - ${e}`));
  }

  if (args.dryRun) {
    printEstimate(stats, args);
    return;
  }

  console.log(`[seed] Analyzing ${toProcess.length} tracks at concurrency=${args.concurrency}...`);
  await runWithConcurrency(
    toProcess,
    async (candidate) => {
      try {
        await analyzeAndStore(supabase, candidate);
        stats.analyzed++;
        console.log(`[ok]   ${candidate.title} — ${candidate.artist}`);
      } catch (err) {
        stats.failed++;
        console.warn(`[fail] ${candidate.title} — ${candidate.artist}:`, err instanceof Error ? err.message : err);
      }
    },
    args.concurrency
  );

  printFinalReport(stats);
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
