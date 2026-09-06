import { describe, expect, it } from 'vitest';
import { mockInsightProvider } from '../../lib/insights/mockProvider';
import { validateEditorialBrief } from '../../lib/insights/validate';
import type { TranscriptSegmentInput } from '../../lib/insights/types';

const englishSegments: TranscriptSegmentInput[] = [
  { id: 'seg_en_1', startMs: 0, endMs: 4000, text: 'Welcome to the show, today we talk about growth.', speaker: 'host' },
  { id: 'seg_en_2', startMs: 4000, endMs: 9000, text: 'Our company grew by 300 percent last year.', speaker: 'host' },
  { id: 'seg_en_3', startMs: 9000, endMs: 14000, text: 'If you liked this, please subscribe to our channel.', speaker: 'host' },
];

const arabicSegments: TranscriptSegmentInput[] = [
  { id: 'seg_ar_1', startMs: 0, endMs: 4000, text: 'أهلاً بكم في الحلقة الجديدة، سنتحدث اليوم عن النمو.', speaker: 'المقدم' },
  { id: 'seg_ar_2', startMs: 4000, endMs: 9000, text: 'نمت شركتنا بنسبة 300 بالمئة العام الماضي.', speaker: 'المقدم' },
  { id: 'seg_ar_3', startMs: 9000, endMs: 14000, text: 'إذا أعجبك هذا المحتوى، اشترك في القناة.', speaker: 'المقدم' },
];

describe('mockInsightProvider', () => {
  it('produces a fully grounded, schema-valid brief for an English transcript', async () => {
    const raw = await mockInsightProvider.extract({ segments: englishSegments, language: 'en', audience: 'founders' });
    const result = validateEditorialBrief(raw, englishSegments);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(`expected valid: ${JSON.stringify(result.failure)}`);
    expect(result.brief.language).toBe('en');
    expect(result.brief.audience).toBe('founders');
    expect(result.brief.claims.length).toBeGreaterThan(0); // "300 percent" should be flagged as a claim
    expect(result.brief.callToAction).not.toBeNull(); // "subscribe" should be detected
  });

  it('produces a fully grounded, schema-valid brief for an Arabic transcript, written in Arabic (not translated English)', async () => {
    const raw = await mockInsightProvider.extract({ segments: arabicSegments, language: 'ar', audience: '' });
    const result = validateEditorialBrief(raw, arabicSegments);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(`expected valid: ${JSON.stringify(result.failure)}`);
    expect(result.brief.language).toBe('ar');
    expect(result.brief.themes[0].label).toMatch(/[؀-ۿ]/); // Arabic scaffolding, not an English label
    expect(result.brief.confidenceNotes).toMatch(/[؀-ۿ]/);
    expect(result.brief.callToAction).not.toBeNull(); // "اشترك" should be detected
    expect(result.brief.claims.length).toBeGreaterThan(0); // "300 بالمئة" should be flagged as a claim
  });

  it('throws on an empty transcript rather than fabricating content', async () => {
    await expect(mockInsightProvider.extract({ segments: [], language: 'en', audience: '' })).rejects.toThrow();
  });
});
