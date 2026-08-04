/**
 * Shared match-filtering rules.
 *
 * Deep Cut mode is enforced server-side in /api/match (which over-fetches
 * candidates so the filter has material to work with) and re-applied
 * client-side as a display guard for stragglers — e.g. when the user toggles
 * the mode after a search has already returned. Both sides must agree, so the
 * threshold and the predicate live here rather than being defined twice.
 */

/**
 * Spotify popularity 0–100. Tracks at or below this are considered obscure.
 * Roughly corresponds to artists with fewer than ~1M streams total.
 */
export const DEEP_CUT_MAX_POPULARITY = 40;

/**
 * Qualitative bands for a cosine similarity score.
 *
 * The UI used to print the raw score as a percentage, which read as precision
 * the number didn't have — under the old embeddings, real similarity occupied
 * a ~0.27-wide band, so "62%" and "58%" were indistinguishable noise. Bands
 * communicate the confidence that actually exists; the exact figure stays
 * available on hover for anyone who wants it.
 *
 * PROVISIONAL: like MATCH_MIN_SIMILARITY, these cuts need measuring against a
 * real seeded catalog before they mean anything precise.
 */
export type MatchStrength = "strong" | "close" | "loose";

export function matchStrength(similarity: number): {
  tone: MatchStrength;
  label: string;
} {
  if (similarity >= 0.6) return { tone: "strong", label: "Strong match" };
  if (similarity >= 0.45) return { tone: "close", label: "Close" };
  return { tone: "loose", label: "Loose" };
}

/** Split a stored `artist` field ("Sufjan Stevens, Bryce Dessner") into names. */
export function splitArtistNames(artist: string): string[] {
  return artist
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether a match survives Deep Cut mode.
 *
 * A null popularity is treated as INELIGIBLE. Unknown popularity is not
 * evidence of obscurity, and admitting unknowns silently broke the mode's
 * promise ("obscure tracks only") — it was the main reason Deep Cut results
 * were indistinguishable from normal ones.
 */
export function isDeepCutEligible(params: {
  popularity: number | null;
  matchArtist: string;
  sourceArtistNames: string[];
}): boolean {
  const { popularity, matchArtist, sourceArtistNames } = params;

  if (popularity === null || popularity > DEEP_CUT_MAX_POPULARITY) return false;

  const matchNames = splitArtistNames(matchArtist);
  const sharesArtist = matchNames.some((m) =>
    sourceArtistNames.some((s) => m.includes(s) || s.includes(m))
  );

  return !sharesArtist;
}
