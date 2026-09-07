import { describe, expect, it } from 'vitest';
import { mockContentProvider } from '../../lib/generation/mockProvider';
import { validateBlogDraft, validateContentDraft } from '../../lib/generation/validate';
import type { ContentGenerationInput, InsightSummary } from '../../lib/generation/types';
import type { EditorialBrief } from '../../src/domain/schemas';

const insights: InsightSummary[] = [
  { id: 'ins_theme', type: 'theme', text: 'Growth through customer conversations.', segmentIds: ['seg_1'], startMs: 0, endMs: 4000 },
  { id: 'ins_kp', type: 'key_point', text: 'Grew from 2 to 4000 paying customers in 18 months.', segmentIds: ['seg_2'], startMs: 4000, endMs: 12000 },
  { id: 'ins_quote', type: 'quote', text: 'Talking to customers every week changes everything.', segmentIds: ['seg_4'], startMs: 18000, endMs: 24000 },
  { id: 'ins_hook', type: 'hook', text: "Here's the thing: we grew fast.", segmentIds: ['seg_1'], startMs: 0, endMs: 4000 },
  { id: 'ins_claim', type: 'claim', text: 'Revenue grew by 300 percent last year.', segmentIds: ['seg_3'], startMs: 12000, endMs: 18000 },
  { id: 'ins_cta', type: 'call_to_action', text: 'Subscribe to the channel.', segmentIds: ['seg_5'], startMs: 24000, endMs: 30000 },
];

const brief: EditorialBrief = {
  thesis: { text: 'We scaled from 2 to 4000 customers by talking to them every week.', evidence: ['seg_1'] },
  audience: 'founders',
  language: 'en',
  themes: [],
  keyPoints: [],
  quotes: [],
  hooks: [],
  candidateClips: [],
  claims: [],
  callToAction: null,
  evidenceMap: {},
  confidenceNotes: 'fixture',
};

function baseInput(overrides: Partial<ContentGenerationInput> = {}): ContentGenerationInput {
  return {
    artifactType: 'blog_draft',
    brief,
    insights,
    settings: { tone: 'informative', audience: 'founders', language: 'en', platform: null },
    ...overrides,
  };
}

describe('mockContentProvider', () => {
  it('generates a grounded, schema-valid blog draft that flags the unverified claim', async () => {
    const raw = await mockContentProvider.generate(baseInput());
    const result = validateContentDraft('blog_draft', raw, insights);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(JSON.stringify(result.failure));
    const data = result.data as { unsupportedClaims: unknown[] };
    expect(data.unsupportedClaims.length).toBeGreaterThan(0); // "300 percent" claim flagged, not stated as fact
  });

  it('generates a grounded X post', async () => {
    const raw = await mockContentProvider.generate(
      baseInput({ artifactType: 'social_post', settings: { tone: 'punchy', audience: 'founders', language: 'en', platform: 'x' } })
    );
    const result = validateContentDraft('social_post', raw, insights);
    expect(result.valid).toBe(true);
  });

  it('generates a grounded LinkedIn post', async () => {
    const raw = await mockContentProvider.generate(
      baseInput({ artifactType: 'social_post', settings: { tone: 'professional', audience: 'founders', language: 'en', platform: 'linkedin' } })
    );
    const result = validateContentDraft('social_post', raw, insights);
    expect(result.valid).toBe(true);
  });

  it('generates a grounded Instagram caption with hashtags', async () => {
    const raw = await mockContentProvider.generate(
      baseInput({ artifactType: 'caption', settings: { tone: 'engaging', audience: 'founders', language: 'en', platform: 'instagram' } })
    );
    const result = validateContentDraft('caption', raw, insights);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(JSON.stringify(result.failure));
    expect((result.data as { hashtags: string[] }).hashtags.length).toBeGreaterThan(0);
  });

  it('generates a grounded, schema-valid Arabic blog draft written natively (not translated)', async () => {
    const raw = await mockContentProvider.generate(
      baseInput({ settings: { tone: 'informative', audience: '', language: 'ar', platform: null } })
    );
    const result = validateBlogDraft(raw, insights);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(JSON.stringify(result.failure));
    expect(result.data.title).toMatch(/[؀-ۿ]/);
    expect(result.data.sections[0].heading).toMatch(/[؀-ۿ]/);
  });

  it('throws rather than fabricating content when there are no insights to ground against', async () => {
    await expect(mockContentProvider.generate(baseInput({ insights: [] }))).rejects.toThrow();
  });
});

describe('mockContentProvider platform differentiation (P1 fix)', () => {
  type SocialData = { hook: string; body: string; callToAction: string | null; hashtags: string[]; evidence: string[] };

  async function generateFor(platform: 'x' | 'linkedin' | 'instagram'): Promise<SocialData> {
    const raw = await mockContentProvider.generate(
      baseInput({
        artifactType: platform === 'instagram' ? 'caption' : 'social_post',
        settings: { tone: 'neutral', audience: 'founders', language: 'en', platform },
      })
    );
    const result = validateContentDraft(platform === 'instagram' ? 'caption' : 'social_post', raw, insights);
    if (!result.valid) throw new Error(JSON.stringify(result.failure));
    return result.data as SocialData;
  }

  it('produces a materially different hook per platform for the same insight set', async () => {
    const [x, linkedin, instagram] = await Promise.all([generateFor('x'), generateFor('linkedin'), generateFor('instagram')]);
    const hooks = new Set([x.hook, linkedin.hook, instagram.hook]);
    expect(hooks.size).toBe(3); // no two platforms produce the same hook text
  });

  it('produces a materially different body/structure per platform, not just re-wrapped text', async () => {
    const [x, linkedin, instagram] = await Promise.all([generateFor('x'), generateFor('linkedin'), generateFor('instagram')]);
    const bodies = new Set([x.body, linkedin.body, instagram.body]);
    expect(bodies.size).toBe(3);
    // LinkedIn is structurally a list-based long-form post; X and Instagram are not.
    expect(linkedin.body).toContain('•');
    expect(x.body).not.toContain('•');
    expect(instagram.body).not.toContain('•');
  });

  it('applies a different CTA policy per platform (X: terse or none, LinkedIn: discussion, Instagram: save/share)', async () => {
    const [x, linkedin, instagram] = await Promise.all([generateFor('x'), generateFor('linkedin'), generateFor('instagram')]);
    expect(linkedin.callToAction).toMatch(/comment|experience/i);
    expect(instagram.callToAction).toMatch(/save|tag|share/i);
    if (x.callToAction) {
      // X's CTA, when present at all, stays terse — nowhere near LinkedIn's discussion-inviting length.
      expect(x.callToAction.length).toBeLessThan(linkedin.callToAction!.length);
    }
  });

  it('uses a different hashtag convention per platform (X: minimal, LinkedIn: few professional, Instagram: many casual)', async () => {
    const [x, linkedin, instagram] = await Promise.all([generateFor('x'), generateFor('linkedin'), generateFor('instagram')]);
    expect(x.hashtags.length).toBeLessThanOrEqual(1);
    expect(linkedin.hashtags.length).toBeGreaterThanOrEqual(2);
    expect(linkedin.hashtags.length).toBeLessThan(instagram.hashtags.length);
    expect(instagram.hashtags.length).toBeGreaterThanOrEqual(5);
  });

  it('is deterministic: the same platform + insights always produces the same draft', async () => {
    const [first, second] = await Promise.all([generateFor('linkedin'), generateFor('linkedin')]);
    expect(first).toEqual(second);
  });

  it('stays fully grounded in real insight IDs across all three platforms', async () => {
    const insightIds = new Set(insights.map((i) => i.id));
    for (const platform of ['x', 'linkedin', 'instagram'] as const) {
      const data = await generateFor(platform);
      expect(data.evidence.length).toBeGreaterThan(0);
      for (const id of data.evidence) {
        expect(insightIds.has(id)).toBe(true);
      }
    }
  });
});
