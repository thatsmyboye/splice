"use client";

import { useRef, useState, useCallback } from "react";
import { Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TrackTimelineProps {
  durationMs: number;
  onTimestampSelect: (timestamp: number) => void;
}

export function TrackTimeline({ durationMs, onTimestampSelect }: TrackTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<number | null>(null); // 0–1 fraction of track
  const [isDragging, setIsDragging] = useState(false);

  const durationSec = durationMs / 1000;

  const positionFromEvent = (e: React.MouseEvent | MouseEvent): number | null => {
    if (!trackRef.current) return null;
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = positionFromEvent(e);
    if (pos === null) return;
    setPosition(pos);
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const pos = positionFromEvent(e);
    if (pos !== null) setPosition(pos);
  }, [isDragging]);

  const stopDrag = useCallback(() => setIsDragging(false), []);

  const handleMarkMoment = useCallback(() => {
    if (position === null) return;
    onTimestampSelect(position * durationSec);
  }, [position, durationSec, onTimestampSelect]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const currentTimeSec = position !== null ? position * durationSec : null;

  // Keep the time label from overflowing the right edge
  const labelTranslate = position !== null && position > 0.85 ? "-100%" : "-8px";

  return (
    <div
      className="space-y-3 bg-secondary/40 rounded-xl p-4 border border-border"
      onMouseMove={handleMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
    >
      {/* Clickable/draggable track bar */}
      <div
        ref={trackRef}
        className="relative w-full h-[72px] flex items-center cursor-crosshair select-none"
        onMouseDown={handleMouseDown}
      >
        {/* Rail */}
        <div className="w-full h-2 bg-muted rounded-full relative">
          {/* Progress fill */}
          {position !== null && (
            <div
              className="absolute top-0 left-0 h-full bg-primary/50 rounded-full transition-none"
              style={{ width: `${position * 100}%` }}
            />
          )}
          {/* Thumb */}
          {position !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary rounded-full shadow-md border-2 border-background transition-none"
              style={{ left: `calc(${position * 100}% - 8px)` }}
            />
          )}
        </div>

        {/* Floating time label */}
        {currentTimeSec !== null && (
          <div
            className="absolute bottom-1 text-xs font-mono text-primary pointer-events-none"
            style={{ left: `${position! * 100}%`, transform: `translateX(${labelTranslate})` }}
          >
            {formatTime(currentTimeSec)}
          </div>
        )}
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground font-mono tabular-nums w-24 shrink-0">
          {currentTimeSec !== null ? formatTime(currentTimeSec) : "–:––"} /{" "}
          {formatTime(durationSec)}
        </span>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={handleMarkMoment}
          disabled={position === null}
          className="gap-1.5 text-xs"
        >
          <Crosshair className="h-3.5 w-3.5" />
          Mark this moment
        </Button>
      </div>
    </div>
  );
}
