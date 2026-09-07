import { describe, expect, it } from 'vitest';
import { buildValueWeights, rankCandidateClips } from '../../lib/insights/candidateClipRanking';
import type { TranscriptSegmentInput } from '../../lib/insights/types';

function seg(id: string, text: string, startMs: number, endMs: number): TranscriptSegmentInput {
  return { id, text, startMs, endMs, speaker: null };
}

describe('rankCandidateClips', () => {
  it('is deterministic: identical input always produces identical output', () => {
    const segments = [
      seg('s1', 'Welcome, today we discuss growth.', 0, 3000),
      seg('s2', 'We doubled revenue in one year by talking to customers every week.', 3000, 9000),
      seg('s3', 'Thanks for watching, subscribe for more.', 9000, 12000),
    ];
    const weights = new Map([['s2', 3]]);
    const a = rankCandidateClips(segments, weights, 'en', 3);
    const b = rankCandidateClips(segments, weights, 'en', 3);
    expect(a).toEqual(b);
  });

  it('preserves startMs, endMs, and segment IDs as real evidence', () => {
    const segments = [
      seg('s1', 'Intro line here.', 0, 2000),
      seg('s2', 'We grew revenue by 300 percent last quarter after fixing onboarding.', 2000, 8000),
    ];
    const weights = buildValueWeights({
      quotes: [{ evidence: ['s2'] }],
      claims: [{ evidence: ['s2'] }],
      keyPoints: [],
      hooks: [],
      themes: [],
      callToAction: null,
    });
    const clips = rankCandidateClips(segments, weights, 'en', 2);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      expect(clip.startMs).toBeGreaterThanOrEqual(0);
      expect(clip.endMs).toBeGreaterThan(clip.startMs);
      expect(clip.evidence.length).toBeGreaterThan(0);
      for (const id of clip.evidence) {
        expect(segments.some((s) => s.id === id)).toBe(true);
      }
    }
  });

  it('never selects the transcript-opening greeting as the top candidate when a substantive segment exists', () => {
    const segments = [
      seg('greet', 'Welcome back to the show, today we are talking about growth.', 0, 4000),
      seg('meat', 'We doubled our revenue after fixing the onboarding flow, going from 2 percent churn to under 1 percent.', 4000, 11000),
      seg('outro', 'Thanks for listening.', 11000, 13000),
    ];
    const weights = buildValueWeights({
      quotes: [{ evidence: ['meat'] }],
      claims: [{ evidence: ['meat'] }],
      keyPoints: [{ evidence: ['meat'] }],
      hooks: [{ evidence: ['greet'] }],
      themes: [],
      callToAction: null,
    });
    const clips = rankCandidateClips(segments, weights, 'en', 3);
    expect(clips[0].evidence).not.toContain('greet');
  });

  it('does not overlap segments across the returned candidates', () => {
    const segments = Array.from({ length: 8 }, (_, i) =>
      seg(`s${i}`, `Segment number ${i} with some meaningful content about growth and metrics.`, i * 3000, (i + 1) * 3000)
    );
    const weights = new Map(segments.map((s) => [s.id, 2]));
    const clips = rankCandidateClips(segments, weights, 'en', 3);
    const seen = new Set<string>();
    for (const clip of clips) {
      for (const id of clip.evidence) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('penalizes a window that opens on a dangling continuation word (contextual independence)', () => {
    const segments = [
      seg('a', 'But that approach completely failed for us in the first month.', 0, 5000),
      seg('b', 'We switched strategy and grew subscribers by 40 percent in two weeks.', 5000, 11000),
    ];
    const weights = new Map([
      ['a', 2],
      ['b', 2],
    ]);
    const clips = rankCandidateClips(segments, weights, 'en', 2);
    // 'b' doesn't open on a continuation marker and has a concrete stat — it should outrank 'a' alone.
    const bOnly = clips.find((c) => c.evidence.length === 1 && c.evidence[0] === 'b');
    const aOnly = clips.find((c) => c.evidence.length === 1 && c.evidence[0] === 'a');
    if (bOnly && aOnly) {
      expect(clips.indexOf(bOnly)).toBeLessThan(clips.indexOf(aOnly));
    }
  });

  it('returns fewer than maxClips when there are not enough non-overlapping windows', () => {
    const segments = [seg('only', 'Just one segment here with enough content to matter.', 0, 4000)];
    const clips = rankCandidateClips(segments, new Map(), 'en', 3);
    expect(clips.length).toBe(1);
  });

  it('regression: reproduces and fixes the exact false positive from the Product Validation Report (Gulf conversational)', () => {
    // Same fixture text as the prior validation run. Under the OLD
    // "longest segment wins" heuristic this picked segment 2 (the
    // meandering "trying to decide what to sell" backstory) over the
    // much stronger segment 5 (a concrete 10x sales result) and
    // segment 6 (a quotable, general lesson).
    const segments = [
      seg('s1', 'يا خوي والله من زمان أبي أسولف وياك عن هالمشروع اللي بديته', 0, 4000),
      seg(
        's2',
        'بصراحة أول شي كان صعب علي أحدد أي منتج أبيع، جربت أكثر من فكرة قبل لا ألقى اللي يناسبني، وأخيراً قررت أشتغل بالعطورات لأن الطلب عليها كبير في السوق المحلي',
        4000,
        11000
      ),
      seg('s3', 'أول شهر بعت بس خمس قطع، كان محبط شوي بصراحة', 11000, 15000),
      seg('s4', 'بس بعدين غيرت الاستراتيجية، صرت أسوي فيديوهات قصيرة أوريهم فيها كيف أسوي العطر، والناس تفاعلوا وايد', 15000, 21000),
      seg('s5', 'الشهر اللي بعده وصلت مبيعاتي لأكثر من ثمانين قطعة، يعني تضاعفت أكثر من عشر مرات', 21000, 26000),
      seg('s6', 'أهم درس تعلمته إن المحتوى أهم من الإعلانات المدفوعة في البداية', 26000, 30000),
      seg('s7', 'لو حاب تبدأ مشروعك الخاص، ابدأ صغير وما تخاف من الغلط', 30000, 34000),
      seg('s8', 'تابعوني في حسابي عشان أشارك معكم التفاصيل أكثر', 34000, 38000),
    ];
    // Mirrors what extractInsights would have grounded: s2 is the
    // longest-text quote (as before), s5 is a claim (a number), s6 a
    // key point/theme.
    const weights = buildValueWeights({
      quotes: [{ evidence: ['s2'] }],
      claims: [{ evidence: ['s5'] }],
      keyPoints: [{ evidence: ['s5'] }, { evidence: ['s6'] }],
      hooks: [{ evidence: ['s1'] }],
      themes: [{ evidence: ['s1', 's4', 's5'] }, { evidence: ['s2', 's3'] }],
      callToAction: { evidence: ['s8'] },
    });

    const clips = rankCandidateClips(segments, weights, 'ar', 3);
    expect(clips.length).toBeGreaterThan(0);

    // The old heuristic's pick (s2 alone, the meandering backstory)
    // must no longer be the #1 result.
    const oldPick = clips.find((c) => c.evidence.length === 1 && c.evidence[0] === 's2');
    const newTop = clips[0];
    expect(newTop.evidence).not.toEqual(['s2']);
    if (oldPick) {
      expect(clips.indexOf(newTop)).toBeLessThan(clips.indexOf(oldPick));
    }

    // The concrete 10x-sales result (s5) — a number, a transformation
    // marker ("تضاعفت"), and a claim — should be part of the top pick.
    expect(newTop.evidence).toContain('s5');
  });
});
