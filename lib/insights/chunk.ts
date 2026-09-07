import type { TranscriptSegmentInput } from './types';

const DEFAULT_CHUNK_TOKEN_BUDGET = 6000;

export function getChunkTokenBudget(): number {
  const raw = process.env.INSIGHT_CHUNK_TOKEN_BUDGET;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHUNK_TOKEN_BUDGET;
}

/**
 * Deterministic, approximate token estimate — not a real tokenizer.
 * Arabic (and other non-Latin scripts) tends to tokenize denser than
 * English under typical BPE vocabularies, so it's estimated
 * separately. Good enough to decide whether to chunk and where to
 * draw boundaries; deliberately conservative (estimates high) rather
 * than risking an oversized prompt.
 */
export function estimateTokens(text: string): number {
  const arabicChars = (text.match(/[؀-ۿ]/g) ?? []).length;
  const isArabicHeavy = text.length > 0 && arabicChars / text.length > 0.3;
  const charsPerToken = isArabicHeavy ? 2.2 : 4;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function estimateSegmentsTokens(segments: TranscriptSegmentInput[]): number {
  return segments.reduce((sum, segment) => sum + estimateTokens(segment.text), 0);
}

/**
 * Deterministic chunk boundaries (P1 from the quality gate: long
 * transcripts must not be sent as one uncapped prompt). Groups
 * consecutive segments — source order is preserved, segments are
 * never reordered or split — until adding the next one would exceed
 * the per-chunk token budget, then starts a new chunk. A single
 * segment that alone exceeds the budget still becomes its own chunk:
 * segments are atomic, since splitting one would lose its stable
 * ID/timestamp mapping back to the transcript.
 */
export function chunkSegments(segments: TranscriptSegmentInput[], tokenBudget: number): TranscriptSegmentInput[][] {
  const chunks: TranscriptSegmentInput[][] = [];
  let current: TranscriptSegmentInput[] = [];
  let currentTokens = 0;

  for (const segment of segments) {
    const segmentTokens = estimateTokens(segment.text);
    if (current.length > 0 && currentTokens + segmentTokens > tokenBudget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(segment);
    currentTokens += segmentTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
