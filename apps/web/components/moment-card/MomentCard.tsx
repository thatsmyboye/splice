import Image from "next/image";
import type { MomentMatch } from "@splice/types";
import { Music, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface MomentCardProps {
  match: MomentMatch;
}

function formatKey(
  keyName: string | null,
  keyMode: "major" | "minor" | null
): string | null {
  if (!keyName) return null;
  return keyMode === "minor" ? `${keyName}m` : keyName;
}

export function MomentCard({ match }: MomentCardProps) {
  const timeStr =
    match.timestamp_s !== null
      ? `${Math.floor(match.timestamp_s / 60)}:${Math.floor(match.timestamp_s % 60).toString().padStart(2, "0")}`
      : null;
  const similarityPct = Math.round(match.similarity_score * 100);
  const keyLabel = formatKey(match.key_name ?? null, match.key_mode ?? null);
  const hasHarmonicData = keyLabel !== null || match.time_signature !== null || match.bpm !== null;

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-start gap-4 hover:border-border/80 transition-colors">
      {match.artwork_url ? (
        <Image
          src={match.artwork_url}
          alt={match.title}
          width={56}
          height={56}
          className="rounded shrink-0"
        />
      ) : (
        <div className="w-14 h-14 bg-muted rounded flex items-center justify-center shrink-0">
          <Music className="h-5 w-5 text-muted-foreground" />
        </div>
      )}

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium leading-tight truncate">{match.title}</p>
            <p className="text-sm text-muted-foreground truncate">
              {match.artist}
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0 text-xs tabular-nums">
            {similarityPct}%
          </Badge>
        </div>

        {timeStr !== null && (
          <p className="text-xs text-muted-foreground">
            Similar moment at{" "}
            <span className="text-foreground font-mono">{timeStr}</span>
          </p>
        )}

        {match.claude_explanation && (
          <p className="text-sm text-muted-foreground/80 italic leading-snug">
            &ldquo;{match.claude_explanation}&rdquo;
          </p>
        )}

        {hasHarmonicData && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {keyLabel && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 font-mono">
                {keyLabel}
              </Badge>
            )}
            {match.time_signature && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 font-mono">
                {match.time_signature}/4
              </Badge>
            )}
            {match.bpm && (
              <span className="text-xs text-muted-foreground font-mono self-center">
                {Math.round(match.bpm)} BPM
              </span>
            )}
          </div>
        )}
      </div>

      <a
        href={
          match.spotify_id.startsWith("ab:")
            ? `https://musicbrainz.org/recording/${match.spotify_id.slice(3)}`
            : `https://open.spotify.com/track/${match.spotify_id}`
        }
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
        title={match.spotify_id.startsWith("ab:") ? "Open on MusicBrainz" : "Open in Spotify"}
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  );
}
