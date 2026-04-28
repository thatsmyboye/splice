"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import type { SpotifyTrack } from "@splice/types";
import { Input } from "@/components/ui/input";
import { Search, Music } from "lucide-react";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightLookahead(text: string, query: string) {
  const trimmed = query.trim();
  if (!trimmed) return text;

  const pattern = new RegExp(`(${escapeRegex(trimmed)})`, "ig");
  const lowerTrimmed = trimmed.toLowerCase();
  const parts = text.split(pattern);
  return parts.map((part, index) =>
    part.toLowerCase() === lowerTrimmed ? (
      <span key={`${part}-${index}`} className="text-foreground font-semibold">
        {part}
      </span>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

export function TrackSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    clearTimeout(timeoutRef.current);
    const currentRequestId = ++requestIdRef.current;
    timeoutRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/spotify/search?q=${encodeURIComponent(query)}&limit=6`
        );
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        // Ignore stale responses so fast typing doesn't flash old results
        if (currentRequestId !== requestIdRef.current) return;
        const nextResults = data.tracks ?? [];
        setResults(nextResults);
        setOpen(nextResults.length > 0 || query.length > 1);
        setActiveIndex(nextResults.length > 0 ? 0 : -1);
      } catch {
        if (currentRequestId !== requestIdRef.current) return;
        setResults([]);
        setOpen(query.length > 1);
        setActiveIndex(-1);
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }, 350);

    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  const handleSelect = (track: SpotifyTrack) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    router.push(`/discover/${track.id}`);
  };

  return (
    <div className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) {
              setOpen(true);
              setActiveIndex((prev) =>
                prev >= 0 && prev < results.length ? prev : 0
              );
            }
          }}
          onKeyDown={(e) => {
            if (!open || results.length === 0) return;

            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((prev) =>
                prev < 0 ? 0 : (prev + 1) % results.length
              );
              return;
            }

            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((prev) =>
                prev < 0 ? results.length - 1 : (prev - 1 + results.length) % results.length
              );
              return;
            }

            if (e.key === "Enter" && activeIndex >= 0) {
              e.preventDefault();
              handleSelect(results[activeIndex]);
            }
          }}
          onBlur={() => {
            timeoutRef.current = setTimeout(() => setOpen(false), 120);
          }}
          placeholder="Search for a song..."
          className="pl-10 h-12 text-base bg-secondary border-border"
          autoComplete="off"
        />
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          {loading && (
            <div className="p-4 text-sm text-muted-foreground text-center">
              Searching...
            </div>
          )}
          {!loading && results.length === 0 && query.length > 1 && (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No results found
            </div>
          )}
          {results.map((track, index) => {
            const artwork =
              track.album.images[2]?.url ?? track.album.images[0]?.url;
            const artist = track.artists.map((a) => a.name).join(", ");
            return (
              <button
                key={track.id}
                onMouseDown={() => handleSelect(track)}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left ${
                  index === activeIndex ? "bg-muted" : "hover:bg-muted"
                }`}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {artwork ? (
                  <Image
                    src={artwork}
                    alt={track.album.name}
                    width={40}
                    height={40}
                    className="rounded shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 bg-muted rounded flex items-center justify-center shrink-0">
                    <Music className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {highlightLookahead(track.name, query)}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {highlightLookahead(artist, query)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
