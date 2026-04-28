/**
 * MusicBrainz API client.
 * Used to resolve title/artist metadata for AcousticBrainz-indexed tracks
 * (which are stored in track_features with spotify_id = "ab:{mbid}").
 */

const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT = "Splice/1.0 (https://github.com/thatsmyboye/splice)";

export interface MBTrackInfo {
  mbid: string;
  title: string;
  artist: string;
}

interface MBRecordingResponse {
  id: string;
  title: string;
  "artist-credit"?: Array<{
    name?: string;
    artist: { id: string; name: string };
  }>;
}

async function fetchMBRecording(mbid: string): Promise<MBTrackInfo | null> {
  try {
    const res = await fetch(
      `${MB_BASE}/recording/${encodeURIComponent(mbid)}?inc=artist-credits&fmt=json`,
      {
        headers: {
          "User-Agent": MB_USER_AGENT,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as MBRecordingResponse;
    const credits = data["artist-credit"] ?? [];
    const artist =
      credits.map((c) => c.name ?? c.artist.name).join(", ") ||
      "Unknown Artist";
    return { mbid, title: data.title ?? "Unknown Title", artist };
  } catch {
    return null;
  }
}

/**
 * Fetch metadata for multiple MBIDs in parallel.
 * Fires all requests concurrently; individual failures return null and are skipped.
 * MusicBrainz rate-limits at 1 req/sec; for small batches (≤20) the natural
 * HTTP round-trip latency keeps us well within that limit in most cases.
 */
export async function getMBRecordings(
  mbids: string[]
): Promise<Map<string, MBTrackInfo>> {
  if (mbids.length === 0) return new Map();

  const settled = await Promise.allSettled(mbids.map(fetchMBRecording));
  const result = new Map<string, MBTrackInfo>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      result.set(mbids[i], r.value);
    }
  });
  return result;
}
