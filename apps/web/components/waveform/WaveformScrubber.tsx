"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Crosshair, GalleryHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MomentSelection } from "./TrackTimeline";

const MAX_WINDOW_S = 20;

interface WaveformScrubberProps {
  previewUrl: string;
  onMomentSelect: (selection: MomentSelection) => void;
}

export function WaveformScrubber({ previewUrl, onMomentSelect }: WaveformScrubberProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<any>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Window mode
  const [windowMode, setWindowMode] = useState(false);
  const [windowStart, setWindowStart] = useState<number | null>(null);
  const [windowEnd, setWindowEnd] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current || !previewUrl) return;

    import("wavesurfer.js").then(({ default: WaveSurfer }) => {
      if (!containerRef.current) return;

      const ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: "hsl(270 76% 40%)",
        progressColor: "hsl(270 76% 68%)",
        cursorColor: "hsl(270 76% 85%)",
        height: 72,
        normalize: true,
        interact: true,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
      });

      wsRef.current = ws;
      ws.load(previewUrl);
      ws.on("ready", () => {
        setIsReady(true);
        setDuration(ws.getDuration());
      });
      ws.on("timeupdate", (t: number) => setCurrentTime(t));
      ws.on("play", () => setIsPlaying(true));
      ws.on("pause", () => setIsPlaying(false));
      ws.on("finish", () => setIsPlaying(false));
    });

    return () => {
      wsRef.current?.destroy();
      wsRef.current = null;
    };
  }, [previewUrl]);

  const togglePlay = useCallback(() => wsRef.current?.playPause(), []);

  // ─── window mode actions ───────────────────────────────────────────────────

  const setStart = () => setWindowStart(currentTime);

  const setEnd = () => {
    if (windowStart === null) return;
    const raw = currentTime;
    // End must be after start and within MAX_WINDOW_S
    const clamped = Math.max(
      windowStart + 0.5,
      Math.min(raw, windowStart + MAX_WINDOW_S)
    );
    setWindowEnd(clamped);
  };

  const toggleWindowMode = () => {
    setWindowMode((v) => !v);
    setWindowStart(null);
    setWindowEnd(null);
  };

  // ─── mark moment ──────────────────────────────────────────────────────────

  const handleMark = () => {
    if (windowMode && windowStart !== null && windowEnd !== null) {
      onMomentSelect({ start_s: windowStart, end_s: windowEnd });
    } else if (!windowMode) {
      onMomentSelect({ start_s: currentTime });
    }
  };

  // ─── display helpers ───────────────────────────────────────────────────────

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const windowDurationS =
    windowStart !== null && windowEnd !== null ? windowEnd - windowStart : 0;

  const windowIsValid = windowDurationS >= 0.5;

  const canMark = windowMode ? windowIsValid : isReady;

  // Window region markers as percentages of the waveform width
  const startPct = duration > 0 && windowStart !== null ? (windowStart / duration) * 100 : null;
  const endPct = duration > 0 && windowEnd !== null ? (windowEnd / duration) * 100 : null;

  return (
    <div className="space-y-3 bg-secondary/40 rounded-xl p-4 border border-border">
      {/* Waveform container with optional window overlay */}
      <div className="relative">
        <div ref={containerRef} className="w-full min-h-[72px] [&>wave]:rounded" />
        {!isReady && (
          <div className="h-[72px] -mt-[72px] flex items-center justify-center text-xs text-muted-foreground">
            Loading waveform...
          </div>
        )}

        {/* Window region overlay */}
        {windowMode && startPct !== null && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: `${startPct}%`, width: endPct !== null ? `${endPct - startPct}%` : "2px" }}
          >
            {/* Start marker line */}
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
            {/* Fill between markers */}
            {endPct !== null && (
              <div className="absolute inset-0 bg-primary/20" />
            )}
            {/* End marker line */}
            {endPct !== null && (
              <div className="absolute right-0 top-0 bottom-0 w-0.5 bg-primary/70" />
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          onClick={togglePlay}
          disabled={!isReady}
          className="shrink-0 h-8 w-8"
        >
          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>

        <span className="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
          {fmt(currentTime)} / {fmt(duration)}
        </span>

        <div className="flex-1" />

        <Button
          variant={windowMode ? "secondary" : "ghost"}
          size="sm"
          onClick={toggleWindowMode}
          className="gap-1.5 text-xs px-2"
          title={windowMode ? "Switch to single point" : "Select a window (max 20s)"}
        >
          <GalleryHorizontal className="h-3.5 w-3.5" />
          Window
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleMark}
          disabled={!canMark}
          className="gap-1.5 text-xs"
        >
          <Crosshair className="h-3.5 w-3.5" />
          {windowMode ? "Mark window" : "Mark this moment"}
        </Button>
      </div>

      {/* Window mode set-start / set-end controls */}
      {windowMode && (
        <div className="flex items-center gap-2 pt-1 border-t border-border/40">
          <Button
            variant={windowStart !== null ? "secondary" : "outline"}
            size="sm"
            onClick={setStart}
            disabled={!isReady}
            className="text-xs flex-1"
          >
            {windowStart !== null ? `Start: ${fmt(windowStart)}` : "Set start"}
          </Button>
          <Button
            variant={windowEnd !== null ? "secondary" : "outline"}
            size="sm"
            onClick={setEnd}
            disabled={!isReady || windowStart === null}
            className="text-xs flex-1"
          >
            {windowEnd !== null
              ? `End: ${fmt(windowEnd)} (${fmt(windowDurationS)})`
              : "Set end"}
          </Button>
        </div>
      )}

      {windowMode && (
        <p className="text-xs text-muted-foreground">
          Play to your moment, set the start, continue playing, then set the end (max {MAX_WINDOW_S}s)
        </p>
      )}
    </div>
  );
}
