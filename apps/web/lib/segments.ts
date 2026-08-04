/**
 * Helpers for locating a segment within a track's v2.0 `segments` array.
 *
 * Both /api/interpret and /api/match need "which segment is the user's
 * timestamp in?" and previously answered it two different ways — interpret
 * took the last segment *starting before* the mark without checking that it
 * contained the mark, which lands on the wrong segment whenever the user
 * selects a point past the end of the analyzed audio.
 */

export interface TrackSegment {
  start_s: number;
  duration_s: number;
  chord_label?: string;
  chord_confidence?: number;
}

/**
 * The segment containing `timestamp_s`, or — when the timestamp falls outside
 * every segment — the nearest one by start time. Matches the fallback the
 * analysis service uses in /embed-window so both sides agree on which segment
 * a given mark refers to.
 *
 * Returns null for an empty segment array. A null timestamp yields the first
 * segment (the description-only case, where there is no mark to locate).
 */
export function segmentAtTimestamp(
  segments: TrackSegment[] | null | undefined,
  timestamp_s: number | null
): TrackSegment | null {
  if (!segments?.length) return null;
  if (timestamp_s === null) return segments[0] ?? null;

  const containing = segments.find(
    (s) => timestamp_s >= s.start_s && timestamp_s < s.start_s + s.duration_s
  );
  if (containing) return containing;

  return segments.reduce((nearest, s) =>
    Math.abs(s.start_s - timestamp_s) < Math.abs(nearest.start_s - timestamp_s)
      ? s
      : nearest
  );
}

/** Chord label at `timestamp_s`, or null when unavailable. */
export function chordAtTimestamp(
  segments: TrackSegment[] | null | undefined,
  timestamp_s: number | null
): string | null {
  return segmentAtTimestamp(segments, timestamp_s)?.chord_label ?? null;
}
