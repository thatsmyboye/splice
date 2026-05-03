"use client";

import { useRef, useState, useCallback } from "react";
import { Crosshair, GalleryHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

const MAX_WINDOW_S = 20;

export interface MomentSelection {
  start_s: number;
  end_s?: number;
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function TimeInput({
  valueSec,
  onCommit,
  maxSec,
  minSec = 0,
  disabled = false,
  placeholder = "0:00",
  className = "",
}: {
  valueSec: number | null;
  onCommit: (s: number) => void;
  maxSec: number;
  minSec?: number;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const parseS = (s: string): number | null => {
    const t = s.trim();
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1]!) * 60 + parseInt(m[2]!);
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  };

  const commit = () => {
    if (draft === null) return;
    const parsed = parseS(draft);
    if (parsed !== null) {
      const clamped = Math.max(minSec, Math.min(parsed, maxSec));
      onCommit(clamped);
    }
    setDraft(null);
  };

  const displayValue = draft !== null ? draft : valueSec !== null ? fmtTime(valueSec) : "";

  return (
    <input
      type="text"
      inputMode="decimal"
      value={displayValue}
      disabled={disabled}
      placeholder={placeholder}
      className={`w-14 px-1.5 py-0.5 text-xs font-mono tabular-nums rounded bg-background border border-border text-center focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-40 ${className}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
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

  // ─── manual timestamp handlers ────────────────────────────────────────────

  const handleManualPoint = (seconds: number) => {
    setPosition(Math.max(0, Math.min(seconds / durationSec, 1)));
  };

  const handleManualWindowStart = (seconds: number) => {
    const frac = Math.max(0, Math.min(seconds / durationSec, 1 - 1 / durationSec));
    setDragAnchor(frac);
    if (dragCurrent !== null && dragCurrent > frac + 1 / durationSec) {
      // Preserve existing end, clamped to max window from new start
      const maxEnd = frac + maxWindowFrac;
      setDragCurrent(Math.min(dragCurrent, maxEnd, 1));
    } else {
      setDragCurrent(frac);
    }
  };

  const handleManualWindowEnd = (seconds: number) => {
    const startFrac = windowStart ?? 0;
    const endFrac = Math.max(0, Math.min(seconds / durationSec, 1));
    // Always set anchor = start, current = end so derivations stay correct
    setDragAnchor(startFrac);
    setDragCurrent(endFrac);
  };

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

  const anchorLabel = (pos: number) =>
    pos > 0.85 ? "-100%" : "-8px";

  const canMark = windowMode ? windowIsValid : position !== null;

  // Computed seconds for inputs
  const windowStartSec = windowStart !== null ? windowStart * durationSec : null;
  const windowEndSec = windowEnd !== null ? windowEnd * durationSec : null;
  const windowEndMaxSec =
    windowStart !== null
      ? Math.min(windowStart * durationSec + MAX_WINDOW_S, durationSec)
      : durationSec;
  const windowEndMinSec = windowStart !== null ? windowStart * durationSec + 1 : 1;

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
            {fmtTime(position * durationSec)}
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
              {fmtTime(windowStart * durationSec)}
            </div>
            {windowEnd > windowStart && (
              <div
                className="absolute bottom-1 text-xs font-mono text-primary/70 pointer-events-none"
                style={{
                  left: `${windowEnd * 100}%`,
                  transform: `translateX(${anchorLabel(windowEnd)})`,
                }}
              >
                {fmtTime(windowEnd * durationSec)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Timestamp inputs */}
        {windowMode ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
            <TimeInput
              valueSec={windowStartSec}
              onCommit={handleManualWindowStart}
              maxSec={Math.max(0, durationSec - 1)}
              placeholder="0:00"
            />
            <span>—</span>
            <TimeInput
              valueSec={windowEndSec}
              onCommit={handleManualWindowEnd}
              minSec={windowEndMinSec}
              maxSec={windowEndMaxSec}
              disabled={windowStart === null}
              placeholder="0:00"
            />
            <span className="tabular-nums">/ {fmtTime(durationSec)}</span>
            {windowDurationS > 0 && (
              <span className="text-muted-foreground/70">({fmtTime(windowDurationS)})</span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
            <TimeInput
              valueSec={position !== null ? position * durationSec : null}
              onCommit={handleManualPoint}
              maxSec={durationSec}
              placeholder="0:00"
            />
            <span className="tabular-nums">/ {fmtTime(durationSec)}</span>
          </div>
        )}

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
          Drag across the timeline to select up to {MAX_WINDOW_S}s, or type times directly into the inputs
        </p>
      )}
    </div>
  );
}
