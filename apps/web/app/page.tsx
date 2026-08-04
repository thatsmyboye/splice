import { TrackSearch } from "@/components/search/TrackSearch";
import { WaveformBackground } from "@/components/waveform/WaveformBackground";
import { AuthButton } from "@/components/auth/AuthButton";

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="absolute inset-0">
        <WaveformBackground />
      </div>

      {/* Transparent over the waveform rather than the bordered SiteHeader —
          the landing page is the one place the wordmark is the hero. */}
      <div className="relative flex justify-end px-4 py-3">
        <AuthButton />
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <div className="w-full max-w-xl space-y-6">
          <div className="text-center">
            <h1 className="text-6xl font-bold tracking-tighter">splice</h1>
          </div>
          <TrackSearch />
          <p className="text-center text-lg text-muted-foreground">
            Find songs that share the exact musical moment you love.
          </p>
        </div>
      </div>
    </main>
  );
}
