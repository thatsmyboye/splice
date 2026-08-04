/**
 * Single-playback registry for result-card previews.
 *
 * Result cards each own an <audio> element. Without coordination, clicking
 * play on a second card layers it over the first. This keeps exactly one
 * playing at a time.
 */

let current: HTMLAudioElement | null = null;

/**
 * Claim playback for `audio`, pausing whatever was playing before.
 * Call immediately before `audio.play()`.
 */
export function claimPlayback(audio: HTMLAudioElement): void {
  if (current && current !== audio) {
    current.pause();
  }
  current = audio;
}

/** Release the claim if `audio` currently holds it. */
export function releasePlayback(audio: HTMLAudioElement): void {
  if (current === audio) {
    current = null;
  }
}
