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

// ============================================================
// Moment interpretation
// ============================================================

const INTERPRET_SYSTEM_PROMPT = `You are an expert music analyst with deep knowledge of music theory, production techniques, and sonic characteristics. Your task is to interpret a listener's description of a specific musical moment and translate it into a structured set of perceptual audio features.

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
  "reasoning": <string, one sentence explaining your interpretation>
}

Scale definitions:
- energy_profile: 0 = near silence/stillness, 1 = maximal intensity/noise
- timbral_character: 0 = warm/muffled/bass-heavy, 1 = bright/sharp/treble-forward
- harmonic_tension: 0 = resolved cadence/tonic/stable, 1 = dissonant/suspended/unresolved
- structural_position: 0 = intro/fade/outro, 0.5 = verse/development, 1 = chorus/climax/drop
- textural_density: 0 = solo instrument/single voice, 1 = full ensemble/wall of sound
- emotional_arc: 0 = descending/grief/resignation, 1 = ascending/release/triumph

Be precise and consistent. A high-energy EDM drop and a loud orchestral climax may both score 0.9 on energy_profile, but differ significantly on timbral_character and structural_position.`;

export async function interpretMoment(params: {
  track: SpotifyTrack;
  timestamp_s?: number;
  description?: string;
  genres?: string[];
}): Promise<MomentDescriptor> {
  const { track, timestamp_s, description, genres } = params;

  if (!timestamp_s && !description) {
    throw new Error("At least one of timestamp_s or description is required");
  }

  const artist = track.artists.map((a) => a.name).join(", ");
  const genreStr = genres?.length ? genres.join(", ") : "unknown genre";

  let userPrompt = `Track: "${track.name}" by ${artist} (${genreStr})`;
  userPrompt += `\nAlbum: ${track.album.name}`;
  userPrompt += `\nTotal duration: ${Math.round(track.duration_ms / 1000)}s`;

  if (timestamp_s !== undefined) {
    const minutes = Math.floor(timestamp_s / 60);
    const seconds = Math.floor(timestamp_s % 60);
    userPrompt += `\n\nThe user has selected the moment at timestamp ${minutes}:${seconds.toString().padStart(2, "0")}.`;
  }

  if (description) {
    userPrompt += `\n\nThe user describes this moment as: "${description}"`;
  }

  userPrompt += `\n\nAnalyze this musical moment and return the structured JSON descriptor.`;

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
    .map(
      (m) =>
        `- spotify_id: ${m.spotify_id}, title: "${m.title}", artist: ${m.artist}`
    )
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
