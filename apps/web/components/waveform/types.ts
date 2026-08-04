/**
 * A moment the user has marked: either a single point in time, or a span.
 *
 * Times are seconds into the audio *currently loaded in the scrubber* — the
 * 30s preview, or the user's full-length file. That distinction matters: the
 * same number means different things depending on which source is active,
 * which is why the discover page states the audio source alongside the mark.
 */
export interface MomentSelection {
  start_s: number;
  end_s?: number;
}
