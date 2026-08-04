"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { MomentMatch } from "@splice/types";
import { ExternalLink, Music, Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { matchStrength } from "@/lib/matching";
import { claimPlayback, releasePlayback } from "@/lib/audio-preview";

interface MomentCardProps {
  match: MomentMatch;
}

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function formatKey(
  keyName: string | null,
  keyMode: "major" | "minor" | null
): string | null {
  if (!keyName) return null;
  return keyMode === "minor" ? `${keyName}m` : keyName;
}

const STRENGTH_CLASSES: Record<string, string> = {
  strong: "bg-primary/15 text-primary border-primary/30",
  close: "bg-secondary text-secondary-foreground border-border",
  loose: "bg-muted/50 text-muted-foreground border-border",
};

export function MomentCard({ match }: MomentCardProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // Set when the matched moment lies past the end of the available preview —
  // e.g. the catalog row was built from a full-length upload but only a 30s
  // preview is playable here.
  const [outOfRange, setOutOfRange] = useState(false);

  const timeStr = match.timestamp_s !== null ? fmtTime(match.timestamp_s) : null;
  const keyLabel = formatKey(match.key_name ?? null, match.key_mode ?? null);
  const strength = matchStrength(match.similarity_score);
  const hasHarmonicData =
    keyLabel !== null ||
    match.time_signature !== null ||
    match.bpm !== null ||
    !!match.chord_label;

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        releasePlayback(audio);
      }
    };
  }, []);

  const togglePlay = useCallback(() => {
    if (!match.preview_url) return;

    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(match.preview_url);
      audio.preload = "metadata";

      // Seek to the matched moment as soon as the duration is known. This is
      // the whole point of the control: the card claims a specific moment is
      // similar, so playback should start there rather than at 0:00.
      audio.addEventListener("loadedmetadata", () => {
        const target = match.timestamp_s;
        if (target === null || !Number.isFinite(audio!.duration)) return;
        if (target < audio!.duration) {
          audio!.currentTime = target;
        } else {
          setOutOfRange(true);
        }
      });

      audio.addEventListener("ended", () => setPlaying(false));
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("play", () => setPlaying(true));

      audioRef.current = audio;
    }

    if (audio.paused) {
      claimPlayback(audio);
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [match.preview_url, match.timestamp_s]);

  return (
    <div className="flex items-start gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/80">
      {/* Artwork doubles as the play control when a preview exists. */}
      <div className="relative h-14 w-14 shrink-0">
        {match.artwork_url ? (
          <Image
            src={match.artwork_url}
            alt={match.title}
            width={56}
            height={56}
            className="rounded"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded bg-muted">
            <Music className="h-5 w-5 text-muted-foreground" />
          </div>
        )}

        {match.preview_url && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={
              playing
                ? "Pause"
                : timeStr
                  ? `Play from ${timeStr}`
                  : "Play preview"
            }
            className="absolute inset-0 flex items-center justify-center rounded bg-black/50 text-white opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[playing=true]:opacity-100"
            data-playing={playing}
          >
            {playing ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5" />
            )}
          </button>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium leading-tight">{match.title}</p>
            <p className="truncate text-sm text-muted-foreground">{match.artist}</p>
          </div>
          {/* Qualitative band, with the raw score on hover — the underlying
              number isn't calibrated finely enough to display as a percentage. */}
          <Badge
            variant="outline"
            className={`shrink-0 text-xs ${STRENGTH_CLASSES[strength.tone]}`}
            title={`Cosine similarity ${match.similarity_score.toFixed(3)}`}
          >
            {strength.label}
          </Badge>
        </div>

        {timeStr !== null && (
          <p className="text-xs text-muted-foreground">
            {match.preview_url ? "Plays from" : "Similar moment at"}{" "}
            <span className="font-mono text-foreground">{timeStr}</span>
            {outOfRange && (
              <span className="ml-1 text-muted-foreground/70">
                (past the end of the 30s preview)
              </span>
            )}
          </p>
        )}

        {match.claude_explanation && (
          <p className="text-sm italic leading-snug text-muted-foreground/80">
            &ldquo;{match.claude_explanation}&rdquo;
          </p>
        )}

        {hasHarmonicData && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {keyLabel && (
              <Badge variant="outline" className="px-1.5 py-0 font-mono text-xs">
                {keyLabel}
              </Badge>
            )}
            {match.time_signature && (
              <Badge variant="outline" className="px-1.5 py-0 font-mono text-xs">
                {match.time_signature}/4
              </Badge>
            )}
            {match.chord_label && match.chord_label !== "N" && (
              <Badge variant="outline" className="px-1.5 py-0 font-mono text-xs">
                {match.chord_label}
              </Badge>
            )}
            {match.bpm && (
              <span className="self-center font-mono text-xs text-muted-foreground">
                {Math.round(match.bpm)} BPM
              </span>
            )}
          </div>
        )}
      </div>

      <a
        href={`https://open.spotify.com/track/${match.spotify_id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        title="Open in Spotify"
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  );
}
