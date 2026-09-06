import { describe, expect, it } from 'vitest';
import { validateEditorialBrief } from '../../lib/insights/validate';
import type { TranscriptSegmentInput } from '../../lib/insights/types';

const segments: TranscriptSegmentInput[] = [
  { id: 'seg_1', startMs: 0, endMs: 5000, text: 'Hello world, this is a test.', speaker: null },
  { id: 'seg_2', startMs: 5000, endMs: 10000, text: 'We have 5 million users today.', speaker: null },
];

function validDraft() {
  return {
    thesis: { text: 'Hello world, this is a test.', evidence: ['seg_1'] },
    audience: 'general',
    language: 'en',
    themes: [{ id: 'theme_1', label: 'Intro', summary: 'An introduction.', evidence: ['seg_1'] }],
    keyPoints: [{ id: 'kp_1', text: 'We have 5 million users today.', evidence: ['seg_2'] }],
    quotes: [{ id: 'quote_1', text: 'We have 5 million users today.', evidence: ['seg_2'] }],
    hooks: [{ id: 'hook_1', text: "Here's the thing: Hello world.", evidence: ['seg_1'] }],
    candidateClips: [
      { id: 'clip_1', startMs: 5000, endMs: 10000, rationale: 'Strong number.', evidence: ['seg_2'] },
    ],
    claims: [
      {
        id: 'claim_1',
        text: 'We have 5 million users today.',
        qualification: 'Speaker-stated figure; not independently verified.',
        evidence: ['seg_2'],
      },
    ],
    callToAction: null as { text: string; evidence: string[] } | null,
    confidenceNotes: 'test fixture',
  };
}

describe('validateEditorialBrief', () => {
  it('accepts a well-formed, fully grounded draft and builds evidenceMap from real segments', () => {
    const result = validateEditorialBrief(validDraft(), segments);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid result');
    expect(result.brief.evidenceMap.seg_1).toEqual({
      segmentIds: ['seg_1'],
      startMs: 0,
      endMs: 5000,
      text: segments[0].text,
    });
    expect(result.brief.evidenceMap.seg_2.text).toBe(segments[1].text);
  });

  it('rejects output referencing a nonexistent segment ID', () => {
    const draft = validDraft();
    draft.quotes[0].evidence = ['seg_999'];
    const result = validateEditorialBrief(draft, segments);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid result');
    expect(result.failure.stage).toBe('grounding');
    expect(result.failure.errors[0]).toContain('seg_999');
  });

  it('rejects malformed structured output (missing required field)', () => {
    const draft = validDraft() as Partial<ReturnType<typeof validDraft>>;
    delete draft.thesis;
    const result = validateEditorialBrief(draft, segments);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid result');
    expect(result.failure.stage).toBe('schema');
  });

  it('rejects an evidence-less claim — nothing may be asserted with zero support', () => {
    const draft = validDraft();
    draft.claims[0].evidence = [];
    const result = validateEditorialBrief(draft, segments);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid result');
    expect(result.failure.stage).toBe('schema');
  });

  it('rejects a call-to-action referencing an unknown segment while other fields are valid', () => {
    const draft = validDraft();
    draft.callToAction = { text: 'Subscribe now', evidence: ['seg_missing'] };
    const result = validateEditorialBrief(draft, segments);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid result');
    expect(result.failure.stage).toBe('grounding');
  });
});
