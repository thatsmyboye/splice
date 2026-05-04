/**
 * Splice — Anthropic Claude API Wrapper
 * apps/web/lib/anthropic.ts
 *
 * All Claude API calls go through this module.
 * Never import the Anthropic SDK directly in route handlers or components.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { MomentDescriptor, SpotifyTrack } from "@splice/types";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = "claude-sonnet-4-5";

// ============================================================
// Zod schemas for Claude response validation
// ============================================================

const MomentDescriptorSchema = z.object({
  energy_profile: z.number().min(0).max(1),
  energy_profile_label: z.string(),
  timbral_character: z.number().min(0).max(1),
  timbral_character_label: z.string(),
  harmonic_tension: z.number().min(0).max(1),
  harmonic_tension_label: z.string(),
  structural_position: z.number().min(0).max(1),
  structural_position_label: z.string(),
  textural_density: z.number().min(0).max(1),
  textural_density_label: z.string(),
  emotional_arc: z.number().min(0).max(1),
  emotional_arc_label: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const MatchExplanationSchema = z.object({
  explanations: z.array(
    z.object({
      spotify_id: z.string(),
      explanation: z.string().max(120),
    })
  ),
});

const SuggestMatchesSchema = z.object({
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        artist: z.string(),
        explanation: z.string().max(120),
        similarity_score: z.number().min(0).max(1),
      })
    )
    .max(8),
});

// ============================================================
// Moment interpretation
// ============================================================

const INTERPRET_SYSTEM_PROMPT = `You are an expert music analyst with deep knowledge of music theory, production techniques, and sonic characteristics. Your task is to interpret a listener's selected moment in a song and translate it into a structured set of perceptual audio features.

You must respond with ONLY a valid JSON object matching this exact schema — no preamble, no explanation, no markdown fences:

{
  "energy_profile": <float 0-1>,
  "energy_profile_label": <string, e.g. "high energy", "quiet and intimate">,
  "timbral_character": <float 0-1>,
  "timbral_character_label": <string, e.g. "warm and dark", "bright and cutting">,
  "harmonic_tension": <float 0-1>,
  "harmonic_tension_label": <string, e.g. "resolved and stable", "suspended and tense">,
  "structural_position": <float 0-1>,
  "structural_position_label": <string, e.g. "intro/outro", "peak/climax">,
  "textural_density": <float 0-1>,
  "textural_density_label": <string, e.g. "sparse and minimal", "dense and layered">,
  "emotional_arc": <float 0-1>,
  "emotional_arc_label": <string, e.g. "melancholic and descending", "euphoric and ascending">,
  "confidence": <float 0-1, your confidence in this interpretation>,
  "reasoning": <string, one confident sentence characterizing this moment — written as a direct statement, never hedged with words like "likely", "probably", or "suggests">
}

Scale definitions:
- energy_profile: 0 = near silence/stillness, 1 = maximal intensity/noise
- timbral_character: 0 = warm/muffled/bass-heavy, 1 = bright/sharp/treble-forward
- harmonic_tension: 0 = resolved cadence/tonic/stable, 1 = dissonant/suspended/unresolved
- structural_position: 0 = intro/fade/outro, 0.5 = verse/development, 1 = chorus/climax/drop
- textural_density: 0 = solo instrument/single voice, 1 = full ensemble/wall of sound
- emotional_arc: 0 = descending/grief/resignation, 1 = ascending/release/triumph

Be precise and consistent. A high-energy EDM drop and a loud orchestral climax may both score 0.9 on energy_profile, but differ significantly on timbral_character and structural_position. Base your interpretation on the track metadata, the timestamp's position within the track structure, and any description provided — write the reasoning as a confident characterization, not a guess.

When audio analysis data is provided (key, time signature, chord), incorporate those facts into your harmonic_tension score and reasoning. A suspension or tritone chord raises harmonic_tension; a resolved tonic chord lowers it. Do not contradict the provided key unless the description strongly implies otherwise.`;

export interface HarmonicContext {
  key_name: string;
  key_mode: string;
  key_confidence: number;
  time_signature: number | null;
  harmonic_rhythm: number | null;
  segment_chord?: string;
  segment_chord_confidence?: number;
}

export async function interpretMoment(params: {
  track: SpotifyTrack;
  timestamp_s?: number;
  timestamp_end_s?: number;
  description?: string;
  genres?: string[];
  harmonicContext?: HarmonicContext;
}): Promise<MomentDescriptor> {
  const { track, timestamp_s, timestamp_end_s, description, genres, harmonicContext } = params;

  if (timestamp_s === undefined && !description) {
    throw new Error("At least one of timestamp_s or description is required");
  }

  const artist = track.artists.map((a) => a.name).join(", ");
  const genreStr = genres?.length ? genres.join(", ") : "unknown genre";
  const durationSec = Math.round(track.duration_ms / 1000);

  let userPrompt = `Track: "${track.name}" by ${artist} (${genreStr})`;
  userPrompt += `\nAlbum: ${track.album.name}`;
  userPrompt += `\nTotal duration: ${durationSec}s`;

  if (timestamp_s !== undefined) {
    const fmt = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    if (timestamp_end_s !== undefined && timestamp_end_s > timestamp_s) {
      const windowDuration = Math.round(timestamp_end_s - timestamp_s);
      userPrompt += `\n\nThe user has selected a ${windowDuration}s window from ${fmt(timestamp_s)} to ${fmt(timestamp_end_s)} (${Math.round((timestamp_s / durationSec) * 100)}% into the track).`;
    } else {
      userPrompt += `\n\nThe user has selected the moment at timestamp ${fmt(timestamp_s)} (${Math.round((timestamp_s / durationSec) * 100)}% into the track).`;
    }
  }

  if (description) {
    userPrompt += `\n\nThe user describes this moment as: "${description}"`;
  }

  if (harmonicContext) {
    const hc = harmonicContext;
    const confPct = Math.round(hc.key_confidence * 100);
    let harmonicLine = `\n\nAudio analysis reveals: key is ${hc.key_name} ${hc.key_mode} (${confPct}% confidence)`;
    if (hc.time_signature) {
      harmonicLine += `, time signature is ${hc.time_signature}/4`;
    }
    if (hc.harmonic_rhythm !== null) {
      const rhythmLabel =
        hc.harmonic_rhythm < 0.3
          ? "slow-moving harmony"
          : hc.harmonic_rhythm < 0.6
            ? "moderate harmonic rhythm"
            : "fast-changing harmony";
      harmonicLine += `, ${rhythmLabel}`;
    }
    if (
      hc.segment_chord &&
      hc.segment_chord !== "N" &&
      (hc.segment_chord_confidence ?? 0) > 0.5
    ) {
      harmonicLine += `. At this moment, the predominant chord is ${hc.segment_chord} (confidence ${Math.round((hc.segment_chord_confidence ?? 0) * 100)}%)`;
    }
    harmonicLine += ".";
    userPrompt += harmonicLine;
  }

  userPrompt += `\n\nInterpret this musical moment and return the structured JSON descriptor.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: INTERPRET_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");

  let parsed: unknown;
  try {
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Claude returned invalid JSON: ${text.slice(0, 200)}`);
  }

  const validated = MomentDescriptorSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Claude response failed validation: ${validated.error.message}`
    );
  }

  return validated.data;
}

// ============================================================
// Claude-based track suggestion (catalog fallback)
// Used when the pgvector catalog is empty and can't return vector matches.
// ============================================================

const SUGGEST_SYSTEM_PROMPT = `You are an expert music curator with encyclopedic knowledge of recorded music. Given a description of a specific musical moment's qualities, suggest other real songs that contain a moment with a similar sonic character.

Focus on the specific audio qualities — energy level, textural density, harmonic tension, timbral brightness — not just genre. A sparse, melancholic piano line in a pop song shares more with a sparse jazz ballad than with a dense pop production.

For each suggestion, assign a similarity_score (0.0–1.0) reflecting how closely the suggested moment matches the source moment's audio qualities. Vary scores meaningfully: a near-perfect match should score 0.88–0.95, a strong match 0.70–0.87, a moderate match 0.55–0.69. Do not assign the same score to multiple suggestions.

Respond with ONLY valid JSON, no preamble or explanation:
{
  "suggestions": [
    { "title": "<exact song title>", "artist": "<exact artist name>", "explanation": "<one sentence: what moment in this song matches, max 15 words>", "similarity_score": <float 0.0–1.0> },
    ...
  ]
}

Use exact, Spotify-searchable titles and artist names. Suggest 5–7 songs.`;

const SUGGEST_DEEP_CUT_ADDENDUM = `

DEEP CUT MODE — this is a hard requirement, not a preference:
- Every suggestion must be from an artist who is genuinely obscure or underground. No exceptions.
- Banned: Grammy winners, artists on major labels (Universal, Sony, Warner, Atlantic, Columbia, Republic, etc.), artists with more than 2 million Spotify monthly listeners, artists who have appeared on mainstream radio, artists who have charted on Billboard Hot 100.
- Allowed: cult underground acts, artists on small independent labels, regional or local artists, self-released music, artists known only within niche communities, deep B-side or bonus-track cuts from artists who themselves never crossed into mainstream awareness.
- If you are not certain an artist is obscure enough, exclude them and choose someone more obscure.
- The user's entire goal is to find music they have almost certainly never encountered before.`;

export async function suggestTrackMatches(params: {
  descriptor: MomentDescriptor;
  sourceTrack: { title: string; artist: string };
  limit?: number;
  deepCut?: boolean;
}): Promise<Array<{ title: string; artist: string; explanation: string; similarity_score: number }>> {
  const { descriptor, sourceTrack, limit = 6, deepCut = false } = params;

  const momentDesc = [
    `Energy: ${descriptor.energy_profile_label} (${descriptor.energy_profile.toFixed(2)})`,
    `Timbre: ${descriptor.timbral_character_label}`,
    `Harmony: ${descriptor.harmonic_tension_label}`,
    `Structure: ${descriptor.structural_position_label}`,
    `Texture: ${descriptor.textural_density_label}`,
    `Emotion: ${descriptor.emotional_arc_label}`,
    `Context: ${descriptor.reasoning}`,
  ].join("\n");

  const systemPrompt = deepCut
    ? SUGGEST_SYSTEM_PROMPT + SUGGEST_DEEP_CUT_ADDENDUM
    : SUGGEST_SYSTEM_PROMPT;

  const userPrompt = `Source song: "${sourceTrack.title}" by ${sourceTrack.artist}

This musical moment has these qualities:
${momentDesc}

Suggest ${limit} other songs (not "${sourceTrack.title}") that contain a moment with a similar sonic character.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(clean);
    const validated = SuggestMatchesSchema.safeParse(parsed);
    if (!validated.success) throw new Error("Schema mismatch");
    return validated.data.suggestions;
  } catch {
    return [];
  }
}

// ============================================================
// Match explanation (re-ranking)
// ============================================================

const EXPLAIN_SYSTEM_PROMPT = `You are a music analyst. You will be given a source musical moment description and a list of matched songs. For each matched song, write a single short sentence (max 15 words) explaining why it shares a similar musical moment to the source. Focus on the specific sonic or structural quality that connects them — not genre.

Respond with ONLY valid JSON, no preamble:
{
  "explanations": [
    { "spotify_id": "<id>", "explanation": "<sentence>" },
    ...
  ]
}`;

export async function explainMatches(params: {
  sourceMomentDescriptor: MomentDescriptor;
  sourceTrack: { title: string; artist: string };
  matches: Array<{
    spotify_id: string;
    title: string;
    artist: string;
    similarity_score: number;
    key_name?: string | null;
    key_mode?: string | null;
  }>;
}): Promise<Map<string, string>> {
  const { sourceMomentDescriptor: descriptor, sourceTrack, matches } = params;

  if (matches.length === 0) return new Map();

  const sourceDesc = [
    `"${sourceTrack.title}" by ${sourceTrack.artist}`,
    `Moment: ${descriptor.energy_profile_label}, ${descriptor.timbral_character_label},`,
    `${descriptor.harmonic_tension_label}, ${descriptor.textural_density_label}`,
    `(${descriptor.reasoning})`,
  ].join(" ");

  const matchList = matches
    .map((m) => {
      const keyInfo =
        m.key_name ? `, key: ${m.key_name} ${m.key_mode ?? ""}`.trim() : "";
      return `- spotify_id: ${m.spotify_id}, title: "${m.title}", artist: ${m.artist}${keyInfo}`;
    })
    .join("\n");

  const userPrompt = `Source moment:\n${sourceDesc}\n\nMatched songs:\n${matchList}\n\nExplain why each matched song shares a similar moment.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: EXPLAIN_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(clean);
    const validated = MatchExplanationSchema.safeParse(parsed);
    if (!validated.success) throw new Error("Schema mismatch");

    const map = new Map<string, string>();
    validated.data.explanations.forEach(({ spotify_id, explanation }) => {
      map.set(spotify_id, explanation);
    });
    return map;
  } catch {
    return new Map();
  }
}
