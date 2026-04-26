import { TrackSearch } from "@/components/search/TrackSearch";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16">
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
