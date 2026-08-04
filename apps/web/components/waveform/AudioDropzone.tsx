"use client";

import { useCallback, useRef, useState } from "react";
import { FileAudio, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const MAX_UPLOAD_MB = 40;

interface AudioDropzoneProps {
  /** Present when a file is already staged. */
  fileName: string | null;
  busy: boolean;
  onFileSelected: (file: File) => void;
  onClear: () => void;
  disabled?: boolean;
}

/**
 * Lets the user supply their own copy of the track so the full recording can
 * be analyzed instead of a 30-second preview.
 *
 * The file is read locally for the waveform and sent once for analysis; it is
 * never stored. That claim is worth stating plainly in the UI — it's both the
 * privacy answer and the reason this is legally uncomplicated.
 */
export function AudioDropzone({
  fileName,
  busy,
  onFileSelected,
  onClear,
  disabled = false,
}: AudioDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const accept = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setSizeError(null);

      const mb = file.size / 1024 / 1024;
      if (mb > MAX_UPLOAD_MB) {
        setSizeError(`${mb.toFixed(1)}MB is over the ${MAX_UPLOAD_MB}MB limit.`);
        return;
      }
      onFileSelected(file);
    },
    [onFileSelected]
  );

  if (fileName) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm">
        {busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : (
          <FileAudio className="h-4 w-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{fileName}</p>
          <p className="text-xs text-muted-foreground">
            {busy
              ? "Analyzing the full track — this takes longer than a preview."
              : "Full track analyzed. Analyzed in memory, never stored."}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          disabled={busy}
          className="h-7 w-7 shrink-0"
          title="Remove file"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) accept(e.dataTransfer.files?.[0]);
        }}
        className={`flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-50 ${
          dragging
            ? "border-primary bg-primary/10"
            : "border-border bg-secondary/40 hover:border-border/80"
        }`}
      >
        <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Use the full track</span>
          <span className="block text-xs text-muted-foreground">
            Drop your own audio file to mark moments anywhere in the song
          </span>
        </span>
      </button>

      {sizeError && <p className="text-xs text-destructive">{sizeError}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          // Reset so re-selecting the same file still fires onChange.
          e.target.value = "";
        }}
      />
    </div>
  );
}
