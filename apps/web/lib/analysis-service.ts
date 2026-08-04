/**
 * Client for the Python analysis service (services/analysis).
 *
 * Authentication is a shared secret header; the service is not public-facing.
 * Every call degrades to null rather than throwing, so a cold or unreachable
 * analysis service never takes down a search — the caller falls back to
 * whatever signal it still has.
 */

/**
 * Identifies the embedding space. Must match EMBEDDING_MODEL_ID in
 * services/analysis/main.py. Vectors from different spaces are not comparable
 * by cosine similarity, so every query filters on this value — mixing two
 * spaces silently is the bug that made the AcousticBrainz catalog useless.
 */
export const EMBEDDING_MODEL_ID = "clap-music-audioset-v1";

export const EMBEDDING_DIM = 512;

const EMBED_TIMEOUT_MS = 10_000;

function serviceConfig(): { url: string; secret: string } | null {
  const url = process.env.ANALYSIS_SERVICE_URL;
  const secret = process.env.ANALYSIS_SERVICE_SECRET;
  if (!url || !secret) return null;
  return { url, secret };
}

/**
 * Embed a natural-language moment description into the shared CLAP audio/text
 * space, so it can be matched against catalog windows directly.
 *
 * Returns null when the service is unconfigured or the call fails.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const config = serviceConfig();
  if (!config) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const res = await fetch(`${config.url}/embed-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Secret": config.secret,
      },
      body: JSON.stringify({ text: trimmed }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[analysis-service] /embed-text returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      embedding?: number[];
      embedding_model?: string;
    };

    // Guard against querying with a vector from a different space than the
    // catalog was built in — that produces confident-looking nonsense.
    if (data.embedding_model && data.embedding_model !== EMBEDDING_MODEL_ID) {
      console.warn(
        `[analysis-service] embedding space mismatch: service returned ${data.embedding_model}, expected ${EMBEDDING_MODEL_ID}`
      );
      return null;
    }

    return data.embedding ?? null;
  } catch (err) {
    console.warn(
      "[analysis-service] /embed-text failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
