"use client";

import { useState, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import type { SpotifyTrack, MomentMatch, MomentDescriptor, SourceAnalysis } from "@splice/types";
import { WaveformScrubber } from "@/components/waveform/WaveformScrubber";
import { MomentCard } from "@/components/moment-card/MomentCard";
import { MomentAnalysisPanel } from "@/components/moment-card/MomentAnalysisPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Loader2, Music, Scissors } from "lucide-react";
import { TrackTimeline } from "@/components/waveform/TrackTimeline";
import type { MomentSelection } from "@/components/waveform/TrackTimeline";

type Stage = "select" | "loading" | "analyzing" | "results" | "error";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 20; // 60s total

interface DiscoverClientProps {
  track: SpotifyTrack;
}

export function DiscoverClient({ track }: DiscoverClientProps) {
  const [stage, setStage] = useState<Stage>("select");
  const [selection, setSelection] = useState<MomentSelection | null>(null);
  const [description, setDescription] = useState("");
  const [descriptor, setDescriptor] = useState<MomentDescriptor | null>(null);
  const [matches, setMatches] = useState<MomentMatch[]>([]);
  const [sourceAnalysis, setSourceAnalysis] = useState<SourceAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deepCutMode, setDeepCutMode] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Spotify popularity ≤ 45 is a rough proxy for tracks with fewer than ~1.5M streams.
  // popularity === null means the track wasn't found on Spotify at all — genuinely obscure.
  const DEEP_CUT_POPULARITY_MAX = 45;
  const visibleMatches = deepCutMode
    ? matches.filter((m) => m.popularity === null || m.popularity <= DEEP_CUT_POPULARITY_MAX)
    : matches;

  const artwork = track.album.images[0]?.url;
  const artist = track.artists.map((a) => a.name).join(", ");
  const canSubmit = selection !== null || description.trim().length > 0;

  const handleMomentSelect = useCallback((sel: MomentSelection) => {
    setSelection(sel);
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  const fetchMatches = async (momentId: string): Promise<{ done: boolean; pending: boolean }> => {
    const matchRes = await fetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ momentId, sourceSpotifyId: track.id }),
    });

    if (!matchRes.ok) {
      const err = await matchRes.json().catch(() => ({}));
      throw new Error(err.error ?? "Matching failed");
    }

    const { matches: m, analysis_pending, source_analysis } = await matchRes.json();

    if (analysis_pending) return { done: false, pending: true };

    setMatches(m);
    if (source_analysis) setSourceAnalysis(source_analysis);
    setStage("results");
    return { done: true, pending: false };
  };

  const pollUntilReady = (momentId: string, attemptsLeft: number) => {
    if (attemptsLeft <= 0) {
      setMatches([]);
      setStage("results");
      return;
    }

    pollRef.current = setTimeout(async () => {
      try {
        const statusRes = await fetch(
          `/api/analyze?spotifyId=${encodeURIComponent(track.id)}`
        );
        const { status } = await statusRes.json();

        if (status === "complete") {
          const { done } = await fetchMatches(momentId);
          if (!done) pollUntilReady(momentId, attemptsLeft - 1);
        } else if (status === "failed") {
          setMatches([]);
          setStage("results");
        } else {
          pollUntilReady(momentId, attemptsLeft - 1);
        }
      } catch {
        pollUntilReady(momentId, attemptsLeft - 1);
      }
    }, POLL_INTERVAL_MS);
  };

  const handleFindMoment = async () => {
    if (!canSubmit) return;

    stopPolling();
    setStage("loading");
    setError(null);
    setMatches([]);
    setSourceAnalysis(null);

    try {
      const interpretRes = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackId: track.id,
          timestamp_s: selection?.start_s ?? undefined,
          timestamp_end_s: selection?.end_s ?? undefined,
          description: description.trim() || undefined,
          trackMetadata: track,
        }),
      });

      if (!interpretRes.ok) {
        const err = await interpretRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Interpretation failed");
      }

      const { descriptor: desc, momentId } = await interpretRes.json();
      setDescriptor(desc);

      if (track.preview_url) {
        fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spotifyId: track.id, previewUrl: track.preview_url }),
        }).catch(() => {});
      }

      const { done, pending } = await fetchMatches(momentId);

      if (!done && pending) {
        setStage("analyzing");
        pollUntilReady(momentId, POLL_MAX_ATTEMPTS);
      }
    } catch (err) {
      stopPolling();
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStage("error");
    }
  };

  const formatSelection = (sel: MomentSelection) => {
    const fmt = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, "0")}`;
    };
    return sel.end_s !== undefined
      ? `${fmt(sel.start_s)} – ${fmt(sel.end_s)}`
      : fmt(sel.start_s);
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <span className="font-semibold text-lg tracking-tight">splice</span>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        {/* Track header */}
        <div className="flex items-center gap-4">
          {artwork ? (
            <Image
              src={artwork}
              alt={track.album.name}
              width={80}
              height={80}
              className="rounded-lg shrink-0"
            />
          ) : (
            <div className="w-20 h-20 bg-muted rounded-lg flex items-center justify-center shrink-0">
              <Music className="h-8 w-8 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight truncate">{track.name}</h1>
            <p className="text-muted-foreground truncate">{artist}</p>
            <p className="text-sm text-muted-foreground/70 truncate">{track.album.name}</p>
          </div>
        </div>

        {/* Waveform scrubber / track timeline */}
        {track.preview_url ? (
          <div className="space-y-2">
            {selection !== null && (
              <p className="text-sm text-primary font-medium">
                Moment marked at {formatSelection(selection)}
              </p>
            )}
            {selection === null && (
              <p className="text-sm text-muted-foreground">
                Scrub to a moment and click &ldquo;Mark this moment&rdquo;
              </p>
            )}
            <WaveformScrubber
              previewUrl={track.preview_url}
              onMomentSelect={handleMomentSelect}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {selection !== null && (
              <p className="text-sm text-primary font-medium">
                Moment marked at {formatSelection(selection)}
              </p>
            )}
            {selection === null && (
              <p className="text-sm text-muted-foreground">
                No audio preview — scrub the timeline to mark where the moment is in the track
              </p>
            )}
            <TrackTimeline
              durationMs={track.duration_ms}
              onMomentSelect={handleMomentSelect}
            />
          </div>
        )}

        {/* Description input + submit */}
        <div className="space-y-3">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && handleFindMoment()}
            placeholder='Describe the moment to sharpen results: "when the bass drops and everything goes quiet..."'
            className="bg-secondary border-border h-11"
          />

          {/* Deep Cut toggle */}
          <button
            type="button"
            onClick={() => setDeepCutMode((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors w-full ${
              deepCutMode
                ? "bg-primary/10 border-primary/40 text-primary"
                : "bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-border/80"
            }`}
          >
            <Scissors className={`h-4 w-4 shrink-0 ${deepCutMode ? "text-primary" : ""}`} />
            <span className="font-medium">Deep Cut mode</span>
            <span className="ml-auto text-xs opacity-70">
              {deepCutMode ? "on — hiding mainstream tracks" : "off — show all"}
            </span>
          </button>

          <Button
            onClick={handleFindMoment}
            disabled={!canSubmit || stage === "loading" || stage === "analyzing"}
            className="w-full h-12 text-base"
          >
            {stage === "loading" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Interpreting moment...
              </>
            ) : stage === "analyzing" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analyzing audio...
              </>
            ) : (
              "Find similar moments →"
            )}
          </Button>
        </div>

        {/* Error state */}
        {stage === "error" && error && (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {(stage === "loading" || stage === "analyzing") && (
          <div className="space-y-3">
            {stage === "analyzing" && (
              <p className="text-sm text-muted-foreground text-center">
                Extracting audio features from the 30s preview — this takes 5–15s the first time.
              </p>
            )}
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-4 p-4 border border-border rounded-lg">
                <Skeleton className="w-14 h-14 rounded shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {stage === "results" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {visibleMatches.length > 0
                  ? `${visibleMatches.length} similar moment${visibleMatches.length === 1 ? "" : "s"}${deepCutMode && visibleMatches.length < matches.length ? ` (${matches.length - visibleMatches.length} hidden by Deep Cut)` : ""}`
                  : "No matches found yet"}
              </h2>
            </div>

            {descriptor && (
              <MomentAnalysisPanel descriptor={descriptor} sourceAnalysis={sourceAnalysis} />
            )}

            {visibleMatches.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {deepCutMode && matches.length > 0
                  ? "All matches were filtered by Deep Cut mode. Try turning it off to see results."
                  : "No matches found for this moment yet. Try adding a description to sharpen the search."}
              </p>
            ) : (
              <div className="space-y-3">
                {visibleMatches.map((match) => (
                  <MomentCard
                    key={`${match.spotify_id}-${match.timestamp_s}`}
                    match={match}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
