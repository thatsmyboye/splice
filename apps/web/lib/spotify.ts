/**
 * Spotify Web API client (metadata only).
 * Uses Client Credentials flow — no user auth required for search/metadata.
 * Does NOT use /audio-features or /audio-analysis (deprecated Nov 2024).
 */

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

// None of these fetches previously had a timeout, so a single stalled
// request (dropped connection, no response ever received) would hang the
// calling code indefinitely rather than throwing -- fine for a single
// live request, but fatal for anything making many sequential calls (e.g.
// scripts/seed-catalog.ts), where it looks exactly like a dead process.
const FETCH_TIMEOUT_MS = 10_000;

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Spotify token error: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}

export async function searchTracks(query: string, limit = 10) {
  const token = await getAccessToken();
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&market=US`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Spotify search failed: ${response.status}`);
  }

  const data = await response.json();
  return data.tracks.items;
}

export async function getTrack(spotifyId: string) {
  const token = await getAccessToken();
  const url = `${SPOTIFY_API_BASE}/tracks/${spotifyId}?market=US`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Spotify track fetch failed: ${response.status}`);
  }

  return response.json();
}
