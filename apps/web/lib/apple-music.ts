/**
 * Apple Music API client (catalog access only — no user auth).
 *
 * Authentication: Apple Developer Program JWT signed with an ES256 private key.
 * Required env vars:
 *   APPLE_MUSIC_KEY_ID    — Key ID from Certificates, Identifiers & Profiles
 *   APPLE_MUSIC_TEAM_ID   — 10-char Apple Developer Team ID
 *   APPLE_MUSIC_PRIVATE_KEY — P-256 private key PEM (newlines as \n in env)
 *
 * All functions return null/[] when env vars are not configured, so the
 * integration degrades gracefully in environments without Apple Music keys.
 */

import crypto from "node:crypto";

const AM_API_BASE = "https://api.music.apple.com/v1";

// See lib/spotify.ts's FETCH_TIMEOUT_MS -- same rationale: an untimed-out
// fetch can hang a caller indefinitely on a single stalled request.
const FETCH_TIMEOUT_MS = 10_000;

// Tokens are valid up to 6 months. We cache per-process for 12 hours.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

function isConfigured(): boolean {
  return !!(
    process.env.APPLE_MUSIC_KEY_ID &&
    process.env.APPLE_MUSIC_TEAM_ID &&
    process.env.APPLE_MUSIC_PRIVATE_KEY
  );
}

function generateDeveloperToken(): string {
  const keyId = process.env.APPLE_MUSIC_KEY_ID!;
  const teamId = process.env.APPLE_MUSIC_TEAM_ID!;
  // Support \n-escaped newlines (common when storing PEM in env vars)
  const privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  // Apple allows up to 15,777,000 seconds (≈6 months)
  const payload = Buffer.from(
    JSON.stringify({ iss: teamId, iat: now, exp: now + 15_777_000 })
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  // Apple Music requires the ECDSA signature in raw R||S format (IEEE P1363 / JOSE),
  // not DER. The dsaEncoding option is available in Node.js 13.2+ (Next.js requires 18+).
  const signature = sign.sign(
    { key: privateKey, dsaEncoding: "ieee-p1363" },
    "base64url"
  );

  return `${signingInput}.${signature}`;
}

function getToken(): string {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const token = generateDeveloperToken();
  cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

// ============================================================
// Data types
// ============================================================

export interface AppleMusicSong {
  id: string;
  attributes: {
    name: string;
    artistName: string;
    albumName: string;
    genreNames: string[];
    isrc: string;
    durationInMillis: number;
    releaseDate?: string;
    artwork: { url: string; width: number; height: number };
    previews: Array<{ url: string }>;
    hasLyrics: boolean;
    url: string;
  };
}

// ============================================================
// ISRC lookup
// ============================================================

/**
 * Resolve a song by ISRC.
 * Returns null when the ISRC is not found in the catalog or on any error.
 * Results are cached by Next.js for 24 h — ISRC→AM ID mappings are stable.
 */
export async function getSongByISRC(
  isrc: string,
  storefront = "us"
): Promise<AppleMusicSong | null> {
  if (!isConfigured()) return null;

  try {
    const token = getToken();
    const url = `${AM_API_BASE}/catalog/${storefront}/songs?filter[isrc]=${encodeURIComponent(isrc)}&limit=1`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      if (res.status !== 404) {
        console.warn(`[apple-music] ISRC lookup ${isrc} returned ${res.status}`);
      }
      return null;
    }

    const data = await res.json();
    return (data.data?.[0] as AppleMusicSong) ?? null;
  } catch (err) {
    console.warn("[apple-music] getSongByISRC error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ============================================================
// Charts
// ============================================================

/**
 * Fetch the top-songs chart for a given storefront.
 * Apple Music returns up to 200 results; we default to 100.
 * Results are cached for 1 hour — charts update daily but we want fresh data.
 */
export async function getChartTracks(
  storefront = "us",
  limit = 100
): Promise<AppleMusicSong[]> {
  if (!isConfigured()) return [];

  try {
    const token = getToken();
    const url = `${AM_API_BASE}/catalog/${storefront}/charts?types=songs&limit=${limit}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 3_600 },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[apple-music] charts fetch for storefront "${storefront}" returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    return (data.results?.songs?.[0]?.data as AppleMusicSong[]) ?? [];
  } catch (err) {
    console.warn("[apple-music] getChartTracks error:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ============================================================
// Helpers
// ============================================================

/** Build the full-resolution artwork URL from Apple Music's template string. */
export function artworkUrl(song: AppleMusicSong, size = 500): string {
  return song.attributes.artwork.url
    .replace("{w}", String(size))
    .replace("{h}", String(size));
}
