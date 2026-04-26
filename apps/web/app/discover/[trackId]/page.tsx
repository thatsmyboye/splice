import { notFound } from "next/navigation";
import { getTrack } from "@/lib/spotify";
import { DiscoverClient } from "./DiscoverClient";

interface Props {
  params: { trackId: string };
}

export async function generateMetadata({ params }: Props) {
  try {
    const track = await getTrack(params.trackId);
    const artist = track.artists.map((a: { name: string }) => a.name).join(", ");
    return {
      title: `${track.name} — ${artist} | splice`,
      description: `Find songs that share a similar musical moment to ${track.name} by ${artist}.`,
    };
  } catch {
    return { title: "splice" };
  }
}

export default async function DiscoverPage({ params }: Props) {
  let track;
  try {
    track = await getTrack(params.trackId);
  } catch {
    notFound();
  }

  return <DiscoverClient track={track} />;
}
