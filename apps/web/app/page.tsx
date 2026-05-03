import { TrackSearch } from "@/components/search/TrackSearch";
import { WaveformBackground } from "@/components/waveform/WaveformBackground";

export default function Home() {
  return (
    <main className="relative min-h-screen flex flex-col overflow-hidden">
      <div className="absolute inset-0">
        <WaveformBackground />
      </div>
      <div className="relative flex-1 flex flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-xl space-y-10">
          <div className="text-center space-y-3">
            <h1 className="text-6xl font-bold tracking-tighter">splice</h1>
            <p className="text-lg text-muted-foreground">
              Find songs that share the exact musical moment you love.
            </p>
          </div>
          <TrackSearch />
        </div>
      </div>
    </main>
  );
}
