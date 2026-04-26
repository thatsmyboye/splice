"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WaveformScrubberProps {
  previewUrl: string;
  onTimestampSelect: (timestamp: number) => void;
}

export function WaveformScrubber({
  previewUrl,
  onTimestampSelect,
}: WaveformScrubberProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!containerRef.current || !previewUrl) return;

    let ws: unknown = null;

    import("wavesurfer.js").then(({ default: WaveSurfer }) => {
      if (!containerRef.current) return;

      ws = WaveSurfer.create({
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waveform = ws as any;
      waveform.load(previewUrl);
      waveform.on("ready", () => {
        setIsReady(true);
        setDuration(waveform.getDuration());
      });
      waveform.on("timeupdate", (time: number) => setCurrentTime(time));
      waveform.on("play", () => setIsPlaying(true));
      waveform.on("pause", () => setIsPlaying(false));
      waveform.on("finish", () => setIsPlaying(false));
    });

    return () => {
      if (wsRef.current) {
        wsRef.current.destroy();
        wsRef.current = null;
        ws = null;
      }
    };
  }, [previewUrl]);

  const togglePlay = useCallback(() => {
    wsRef.current?.playPause();
  }, []);

  const handleSelectMoment = useCallback(() => {
    onTimestampSelect(currentTime);
  }, [currentTime, onTimestampSelect]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-3 bg-secondary/40 rounded-xl p-4 border border-border">
      <div
        ref={containerRef}
        className="w-full min-h-[72px] [&>wave]:rounded"
      />
      {!isReady && (
        <div className="h-[72px] -mt-[72px] flex items-center justify-center text-xs text-muted-foreground">
          Loading waveform...
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="icon"
          onClick={togglePlay}
          disabled={!isReady}
          className="shrink-0 h-8 w-8"
        >
          {isPlaying ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </Button>

        <span className="text-xs text-muted-foreground font-mono w-24 shrink-0 tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        <div className="flex-1" />

        <Button
          variant="outline"
          size="sm"
          onClick={handleSelectMoment}
          disabled={!isReady}
          className="gap-1.5 text-xs"
        >
          <Crosshair className="h-3.5 w-3.5" />
          Mark this moment
        </Button>
      </div>
    </div>
  );
}
