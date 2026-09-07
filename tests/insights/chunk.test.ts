import { describe, expect, it } from 'vitest';
import { chunkSegments, estimateSegmentsTokens, estimateTokens, getChunkTokenBudget } from '../../lib/insights/chunk';
import type { TranscriptSegmentInput } from '../../lib/insights/types';

function segment(id: string, text: string, startMs: number, endMs: number): TranscriptSegmentInput {
  return { id, text, startMs, endMs, speaker: null };
}

describe('estimateTokens', () => {
  it('is deterministic — the same text always estimates the same', () => {
    const text = 'This is a fairly ordinary sentence about startups and growth.';
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it('estimates more tokens for longer text', () => {
    const short = 'Short sentence.';
    const long = 'This is a much, much longer sentence that goes on for quite a while and has many more words in it.';
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  it('estimates Arabic text with a denser (higher tokens-per-char) ratio than English', () => {
    const arabicText = 'هذا نص عربي طويل نسبياً يحتوي على العديد من الكلمات والجمل المختلفة';
    const englishText = 'This is a relatively long English text containing many different words and sentences';
    expect(estimateTokens(arabicText) / arabicText.length).toBeGreaterThan(estimateTokens(englishText) / englishText.length);
  });
});

describe('getChunkTokenBudget', () => {
  it('defaults to a sane budget when unconfigured', () => {
    delete process.env.INSIGHT_CHUNK_TOKEN_BUDGET;
    expect(getChunkTokenBudget()).toBeGreaterThan(0);
  });

  it('honors INSIGHT_CHUNK_TOKEN_BUDGET when set', () => {
    process.env.INSIGHT_CHUNK_TOKEN_BUDGET = '1234';
    expect(getChunkTokenBudget()).toBe(1234);
    delete process.env.INSIGHT_CHUNK_TOKEN_BUDGET;
  });
});

describe('chunkSegments', () => {
  it('returns a single chunk when everything fits under budget', () => {
    const segments = [segment('s1', 'short', 0, 1000), segment('s2', 'also short', 1000, 2000)];
    const chunks = chunkSegments(segments, 1000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toEqual(segments);
  });

  it('preserves segment order and never splits or drops a segment', () => {
    const segments = Array.from({ length: 20 }, (_, i) => segment(`s${i}`, 'a segment of moderate length here', i * 1000, (i + 1) * 1000));
    const chunks = chunkSegments(segments, 50); // tiny budget forces many chunks
    const flattened = chunks.flat();
    expect(flattened.map((s) => s.id)).toEqual(segments.map((s) => s.id));
  });

  it('produces deterministic boundaries — same input and budget always chunk the same way', () => {
    const segments = Array.from({ length: 15 }, (_, i) => segment(`s${i}`, 'a moderately sized sentence about growth', i * 1000, (i + 1) * 1000));
    const chunksA = chunkSegments(segments, 60);
    const chunksB = chunkSegments(segments, 60);
    expect(chunksA.map((c) => c.map((s) => s.id))).toEqual(chunksB.map((c) => c.map((s) => s.id)));
  });

  it('never splits a single oversized segment across chunks — it becomes its own chunk', () => {
    const huge = segment('huge', 'x'.repeat(10_000), 0, 1000);
    const normal = segment('normal', 'short segment', 1000, 2000);
    const chunks = chunkSegments([huge, normal], 100);
    expect(chunks[0]).toEqual([huge]);
    expect(chunks.some((c) => c.some((s) => s.id === 'normal'))).toBe(true);
  });

  it('keeps each chunk at or under budget except for an unavoidable single oversized segment', () => {
    const segments = Array.from({ length: 10 }, (_, i) => segment(`s${i}`, 'ten words in this sentence right about here now', i * 1000, (i + 1) * 1000));
    const budget = 30;
    const chunks = chunkSegments(segments, budget);
    for (const chunk of chunks) {
      if (chunk.length === 1) continue; // a lone oversized segment is allowed to exceed budget
      expect(estimateSegmentsTokens(chunk)).toBeLessThanOrEqual(budget);
    }
  });
});
