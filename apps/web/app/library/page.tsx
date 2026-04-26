import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { ArrowLeft, Music } from "lucide-react";

export const metadata = {
  title: "My Moments | splice",
};

export default async function LibraryPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: moments } = await supabase
    .from("moments")
    .select(
      `
      id, title, timestamp_start_s, user_description, created_at,
      tracks (spotify_id, title, artist, artwork_url)
    `
    )
    .eq("user_id", user.id)
    .eq("is_saved", true)
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <span className="font-semibold text-lg tracking-tight">My Moments</span>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8">
        {!moments || moments.length === 0 ? (
          <div className="text-center py-24 space-y-4">
            <Music className="mx-auto h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">No saved moments yet.</p>
            <Link
              href="/"
              className="text-primary hover:underline text-sm inline-block"
            >
              Find your first moment →
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {moments.map((moment) => {
              const track = moment.tracks as {
                spotify_id: string;
                title: string;
                artist: string;
                artwork_url: string | null;
              } | null;

              return (
                <Link
                  key={moment.id}
                  href={track ? `/discover/${track.spotify_id}` : "#"}
                  className="flex items-center gap-4 p-4 bg-card border border-border rounded-lg hover:bg-muted/30 transition-colors"
                >
                  {track?.artwork_url ? (
                    <Image
                      src={track.artwork_url}
                      alt={track.title}
                      width={48}
                      height={48}
                      className="rounded shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 bg-muted rounded flex items-center justify-center shrink-0">
                      <Music className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {moment.title ?? track?.title ?? "Untitled Moment"}
                    </p>
                    <p className="text-sm text-muted-foreground truncate">
                      {track?.artist}
                    </p>
                    {moment.user_description && (
                      <p className="text-xs text-muted-foreground/70 mt-0.5 truncate italic">
                        &ldquo;{moment.user_description}&rdquo;
                      </p>
                    )}
                  </div>
                  {moment.timestamp_start_s !== null && (
                    <span className="text-xs font-mono text-muted-foreground shrink-0 tabular-nums">
                      {Math.floor(moment.timestamp_start_s / 60)}:
                      {String(
                        Math.floor(moment.timestamp_start_s % 60)
                      ).padStart(2, "0")}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
