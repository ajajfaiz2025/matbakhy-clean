import { describe, expect, it } from 'vitest';
import { validateBlogDraft, validateSocialDraft } from '../../lib/generation/validate';
import type { InsightSummary } from '../../lib/generation/types';

const insights: InsightSummary[] = [
  { id: 'ins_1', type: 'theme', text: 'Growth theme.', segmentIds: ['seg_1'], startMs: 0, endMs: 4000 },
  { id: 'ins_2', type: 'quote', text: 'A great quote.', segmentIds: ['seg_2'], startMs: 4000, endMs: 8000 },
];

function validBlogDraft() {
  return {
    title: 'How We Grew',
    introduction: 'An intro.',
    sections: [{ heading: 'Growth', body: 'We grew a lot.', evidence: ['ins_1'] }],
    conclusion: 'The end.',
    callToAction: { text: 'Subscribe', evidence: ['ins_2'] },
    unsupportedClaims: [],
  };
}

function validSocialDraft() {
  return {
    title: 'x draft',
    hook: 'Big hook',
    body: 'The body',
    callToAction: null,
    hashtags: [],
    evidence: ['ins_1', 'ins_2'],
    unsupportedClaims: [],
  };
}

describe('validateBlogDraft', () => {
  it('accepts a well-formed, fully grounded draft and builds groundingMap from real insights', () => {
    const result = validateBlogDraft(validBlogDraft(), insights);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.groundingMap.ins_1).toEqual({
      insightType: 'theme',
      text: 'Growth theme.',
      segmentIds: ['seg_1'],
      startMs: 0,
      endMs: 4000,
    });
  });

  it('rejects a section referencing a nonexistent insight ID', () => {
    const draft = validBlogDraft();
    draft.sections[0].evidence = ['ins_missing'];
    const result = validateBlogDraft(draft, insights);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid');
    expect(result.failure.stage).toBe('grounding');
    expect(result.failure.errors[0]).toContain('ins_missing');
  });

  it('rejects malformed structured output (missing required field)', () => {
    const draft = validBlogDraft() as Partial<ReturnType<typeof validBlogDraft>>;
    delete draft.sections;
    const result = validateBlogDraft(draft, insights);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid');
    expect(result.failure.stage).toBe('schema');
  });

  it('rejects an evidence-less section', () => {
    const draft = validBlogDraft();
    draft.sections[0].evidence = [];
    const result = validateBlogDraft(draft, insights);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid');
    expect(result.failure.stage).toBe('schema');
  });
});

describe('validateSocialDraft', () => {
  it('accepts a well-formed, fully grounded social draft', () => {
    const result = validateSocialDraft(validSocialDraft(), insights);
    expect(result.valid).toBe(true);
  });

  it('rejects output referencing a nonexistent insight ID', () => {
    const draft = validSocialDraft();
    draft.evidence = ['ins_missing'];
    const result = validateSocialDraft(draft, insights);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid');
    expect(result.failure.stage).toBe('grounding');
  });
});
