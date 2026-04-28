import Image from "next/image";
import type { MomentMatch } from "@splice/types";
import { Music, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface MomentCardProps {
  match: MomentMatch;
}

export function MomentCard({ match }: MomentCardProps) {
  const minutes = Math.floor(match.timestamp_s / 60);
  const seconds = Math.floor(match.timestamp_s % 60);
  const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const similarityPct = Math.round(match.similarity_score * 100);

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

        <p className="text-xs text-muted-foreground">
          Similar moment at{" "}
          <span className="text-foreground font-mono">{timeStr}</span>
        </p>

        {match.claude_explanation && (
          <p className="text-sm text-muted-foreground/80 italic leading-snug">
            &ldquo;{match.claude_explanation}&rdquo;
          </p>
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
