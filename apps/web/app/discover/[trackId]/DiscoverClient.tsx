"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import type { SpotifyTrack, MomentMatch, MomentDescriptor } from "@splice/types";
import { WaveformScrubber } from "@/components/waveform/WaveformScrubber";
import { MomentCard } from "@/components/moment-card/MomentCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Loader2, Music } from "lucide-react";

type Stage = "select" | "loading" | "results" | "error";

interface DiscoverClientProps {
  track: SpotifyTrack;
}

export function DiscoverClient({ track }: DiscoverClientProps) {
  const [stage, setStage] = useState<Stage>("select");
  const [timestamp, setTimestamp] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [descriptor, setDescriptor] = useState<MomentDescriptor | null>(null);
  const [matches, setMatches] = useState<MomentMatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const artwork = track.album.images[0]?.url;
  const artist = track.artists.map((a) => a.name).join(", ");
  const canSubmit = timestamp !== null || description.trim().length > 0;

  const handleTimestampSelect = useCallback((ts: number) => {
    setTimestamp(ts);
  }, []);

  const handleFindMoment = async () => {
    if (!canSubmit) return;

    setStage("loading");
    setError(null);
    setMatches([]);

    try {
      const interpretRes = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackId: track.id,
          timestamp_s: timestamp ?? undefined,
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

      // Fire-and-forget analysis trigger if track has a preview
      if (track.preview_url) {
        fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spotifyId: track.id,
            previewUrl: track.preview_url,
          }),
        }).catch(() => {});
      }

      const matchRes = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentId, sourceSpotifyId: track.id }),
      });

      if (!matchRes.ok) {
        const err = await matchRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Matching failed");
      }

      const { matches: m } = await matchRes.json();
      setMatches(m);
      setStage("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStage("error");
    }
  };

  const formatTimestamp = (ts: number) => {
    const m = Math.floor(ts / 60);
    const s = Math.floor(ts % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
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
            <h1 className="text-2xl font-bold leading-tight truncate">
              {track.name}
            </h1>
            <p className="text-muted-foreground truncate">{artist}</p>
            <p className="text-sm text-muted-foreground/70 truncate">
              {track.album.name}
            </p>
          </div>
        </div>

        {/* Waveform scrubber */}
        {track.preview_url ? (
          <div className="space-y-2">
            {timestamp !== null && (
              <p className="text-sm text-primary font-medium">
                Moment marked at {formatTimestamp(timestamp)}
              </p>
            )}
            {timestamp === null && (
              <p className="text-sm text-muted-foreground">
                Scrub to a moment and click &ldquo;Mark this moment&rdquo;, or
                describe it below
              </p>
            )}
            <WaveformScrubber
              previewUrl={track.preview_url}
              onTimestampSelect={handleTimestampSelect}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-secondary/30 p-4 text-sm text-muted-foreground text-center">
            No 30s preview available for this track. Describe the moment below.
          </div>
        )}

        {/* Description input + submit */}
        <div className="space-y-3">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && handleFindMoment()}
            placeholder='Or describe it: "when the bass drops and everything goes quiet..."'
            className="bg-secondary border-border h-11"
          />
          <Button
            onClick={handleFindMoment}
            disabled={!canSubmit || stage === "loading"}
            className="w-full h-12 text-base"
          >
            {stage === "loading" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Finding similar moments...
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
        {stage === "loading" && (
          <div className="space-y-3">
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
                {matches.length > 0
                  ? `${matches.length} similar moments`
                  : "No matches found yet"}
              </h2>
            </div>

            {descriptor && (
              <div className="text-sm text-muted-foreground bg-secondary/50 rounded-lg p-3 border border-border/50">
                <span className="font-medium text-foreground">
                  Moment interpreted:{" "}
                </span>
                {descriptor.reasoning}
              </div>
            )}

            {matches.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                The catalog is still being indexed. Try analyzing more tracks!
              </p>
            ) : (
              <div className="space-y-3">
                {matches.map((match) => (
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
