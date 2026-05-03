"use client";

import { useRef, useState, useCallback } from "react";
import { Crosshair, GalleryHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

const MAX_WINDOW_S = 20;

export interface MomentSelection {
  start_s: number;
  end_s?: number;
}

interface TrackTimelineProps {
  durationMs: number;
  onMomentSelect: (selection: MomentSelection) => void;
}

export function TrackTimeline({ durationMs, onMomentSelect }: TrackTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [windowMode, setWindowMode] = useState(false);

  // Point mode
  const [position, setPosition] = useState<number | null>(null);

  // Window mode — anchor is where the drag started, current follows the pointer
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  const [dragCurrent, setDragCurrent] = useState<number | null>(null);

  const durationSec = durationMs / 1000;
  const maxWindowFrac = MAX_WINDOW_S / durationSec;

  // ─── coordinate helpers ────────────────────────────────────────────────────

  const fractionFromClientX = useCallback(
    (clientX: number): number | null => {
      if (!trackRef.current) return null;
      const rect = trackRef.current.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    },
    []
  );

  // ─── derived window bounds ─────────────────────────────────────────────────

  const windowStart =
    dragAnchor !== null && dragCurrent !== null
      ? Math.min(dragAnchor, dragCurrent)
      : null;

  // Clamp so window never exceeds MAX_WINDOW_S
  const windowEnd =
    dragAnchor !== null && dragCurrent !== null
      ? Math.min(
          Math.max(dragAnchor, dragCurrent),
          Math.min(dragAnchor, dragCurrent) + maxWindowFrac
        )
      : null;

  const windowDurationS =
    windowStart !== null && windowEnd !== null
      ? (windowEnd - windowStart) * durationSec
      : 0;

  const windowIsValid = windowDurationS >= 1;

  // ─── pointer-agnostic handlers ────────────────────────────────────────────

  const onDown = useCallback(
    (clientX: number) => {
      const pos = fractionFromClientX(clientX);
      if (pos === null) return;
      isDraggingRef.current = true;
      if (windowMode) {
        setDragAnchor(pos);
        setDragCurrent(pos);
      } else {
        setPosition(pos);
      }
    },
    [windowMode, fractionFromClientX]
  );

  const onMove = useCallback(
    (clientX: number) => {
      if (!isDraggingRef.current) return;
      const pos = fractionFromClientX(clientX);
      if (pos === null) return;
      if (windowMode) {
        setDragCurrent(pos);
      } else {
        setPosition(pos);
      }
    },
    [windowMode, fractionFromClientX]
  );

  const onUp = useCallback(() => { isDraggingRef.current = false; }, []);

  // ─── mouse event handlers ──────────────────────────────────────────────────

  const handleMouseDown = (e: React.MouseEvent) => onDown(e.clientX);
  const handleMouseMove = (e: React.MouseEvent) => onMove(e.clientX);

  // ─── touch event handlers ─────────────────────────────────────────────────

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault(); // prevent scroll while scrubbing
    const t = e.touches[0];
    if (t) onDown(t.clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) onMove(t.clientX);
  };

  // ─── mark moment ──────────────────────────────────────────────────────────

  const handleMark = () => {
    if (windowMode && windowIsValid && windowStart !== null && windowEnd !== null) {
      onMomentSelect({
        start_s: windowStart * durationSec,
        end_s: windowEnd * durationSec,
      });
    } else if (!windowMode && position !== null) {
      onMomentSelect({ start_s: position * durationSec });
    }
  };

  // ─── mode toggle ───────────────────────────────────────────────────────────

  const toggleWindowMode = () => {
    setWindowMode((v) => !v);
    setPosition(null);
    setDragAnchor(null);
    setDragCurrent(null);
  };

  // ─── display helpers ───────────────────────────────────────────────────────

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const anchorLabel = (pos: number) =>
    pos > 0.85 ? "-100%" : "-8px";

  const canMark = windowMode ? windowIsValid : position !== null;

  return (
    <div
      className="space-y-3 bg-secondary/40 rounded-xl p-4 border border-border"
      onMouseMove={handleMouseMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
    >
      {/* Scrub rail */}
      <div
        ref={trackRef}
        className="relative w-full h-[72px] flex items-center cursor-crosshair select-none touch-none"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={onUp}
      >
        <div className="w-full h-2 bg-muted rounded-full relative">
          {/* Point mode: progress fill */}
          {!windowMode && position !== null && (
            <div
              className="absolute top-0 left-0 h-full bg-primary/50 rounded-full"
              style={{ width: `${position * 100}%` }}
            />
          )}

          {/* Window mode: range fill */}
          {windowMode && windowStart !== null && windowEnd !== null && (
            <div
              className="absolute top-0 h-full bg-primary/40 rounded-full"
              style={{
                left: `${windowStart * 100}%`,
                width: `${(windowEnd - windowStart) * 100}%`,
              }}
            />
          )}

          {/* Point mode thumb */}
          {!windowMode && position !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary rounded-full shadow-md border-2 border-background"
              style={{ left: `calc(${position * 100}% - 8px)` }}
            />
          )}

          {/* Window mode: start handle */}
          {windowMode && windowStart !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary rounded-full shadow-md border-2 border-background"
              style={{ left: `calc(${windowStart * 100}% - 8px)` }}
            />
          )}

          {/* Window mode: end handle */}
          {windowMode && windowEnd !== null && windowEnd !== windowStart && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary/70 rounded-full shadow-md border-2 border-background"
              style={{ left: `calc(${windowEnd * 100}% - 8px)` }}
            />
          )}
        </div>

        {/* Point mode label */}
        {!windowMode && position !== null && (
          <div
            className="absolute bottom-1 text-xs font-mono text-primary pointer-events-none"
            style={{
              left: `${position * 100}%`,
              transform: `translateX(${anchorLabel(position)})`,
            }}
          >
            {fmt(position * durationSec)}
          </div>
        )}

        {/* Window mode labels */}
        {windowMode && windowStart !== null && windowEnd !== null && (
          <>
            <div
              className="absolute bottom-1 text-xs font-mono text-primary pointer-events-none"
              style={{
                left: `${windowStart * 100}%`,
                transform: `translateX(${anchorLabel(windowStart)})`,
              }}
            >
              {fmt(windowStart * durationSec)}
            </div>
            {windowEnd > windowStart && (
              <div
                className="absolute bottom-1 text-xs font-mono text-primary/70 pointer-events-none"
                style={{
                  left: `${windowEnd * 100}%`,
                  transform: `translateX(${anchorLabel(windowEnd)})`,
                }}
              >
                {fmt(windowEnd * durationSec)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="text-xs text-muted-foreground font-mono tabular-nums">
          {windowMode
            ? windowStart !== null && windowEnd !== null
              ? `${fmt(windowStart * durationSec)} – ${fmt(windowEnd * durationSec)}`
              : "drag to select"
            : position !== null
            ? fmt(position * durationSec)
            : "–:––"}
          {" / "}
          {fmt(durationSec)}
        </span>

        <div className="flex items-center gap-2 sm:ml-auto">
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
            className="gap-1.5 text-xs flex-1 sm:flex-none"
          >
            <Crosshair className="h-3.5 w-3.5" />
            {windowMode ? "Mark window" : "Mark moment"}
          </Button>
        </div>
      </div>

      {windowMode && (
        <p className="text-xs text-muted-foreground">
          Drag across the timeline to select up to {MAX_WINDOW_S}s of audio for richer matching
        </p>
      )}
    </div>
  );
}
