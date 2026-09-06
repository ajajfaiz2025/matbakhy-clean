import type { ContentGenerationInput, ContentGenerationProvider, InsightSummary } from './types';

/**
 * Deterministic placeholder provider — it does not perform real
 * writing or editorial judgment. It exists so the Editorial Brief ->
 * content-generation pipeline can be built, run, and tested end to
 * end (in both Arabic and English, across blog/X/LinkedIn/Instagram)
 * before a real generation budget/API key is configured. Swap
 * getContentProvider() (./index.ts) to a real provider once one is
 * available. Every field it returns is grounded in real Insight text
 * — nothing is invented — but the prose itself is placeholder
 * scaffolding, not publishable writing.
 */
export const mockContentProvider: ContentGenerationProvider = {
  name: 'mock',
  async generate(input: ContentGenerationInput) {
    if (input.insights.length === 0) {
      throw new Error('Cannot generate content without any extracted insights.');
    }
    const isArabic = input.settings.language === 'ar';
    return input.artifactType === 'blog_draft'
      ? buildBlogDraft(input, isArabic)
      : buildSocialDraft(input, isArabic);
  },
};

function byType(insights: InsightSummary[], type: string): InsightSummary[] {
  return insights.filter((insight) => insight.type === type);
}

function buildBlogDraft(input: ContentGenerationInput, isArabic: boolean) {
  const { insights, brief } = input;
  const themes = byType(insights, 'theme');
  const keyPoints = byType(insights, 'key_point');
  const quotes = byType(insights, 'quote');
  const claims = byType(insights, 'claim');
  const cta = byType(insights, 'call_to_action')[0];

  const sections: Array<{ heading: string; body: string; evidence: string[] }> = [];

  if (themes.length > 0) {
    sections.push({
      heading: isArabic ? 'الفكرة الرئيسية' : 'The Big Idea',
      body: isArabic
        ? `[مسودة تجريبية] ${themes.map((t) => t.text).join(' ')}`
        : `[mock draft] ${themes.map((t) => t.text).join(' ')}`,
      evidence: themes.map((t) => t.id),
    });
  }
  if (keyPoints.length > 0) {
    sections.push({
      heading: isArabic ? 'أبرز النقاط' : 'Key Takeaways',
      body: isArabic
        ? `[مسودة تجريبية] ${keyPoints.map((k) => k.text).join(' ')}`
        : `[mock draft] ${keyPoints.map((k) => k.text).join(' ')}`,
      evidence: keyPoints.map((k) => k.id),
    });
  }
  if (quotes.length > 0) {
    sections.push({
      heading: isArabic ? 'بكلماتهم' : 'In Their Own Words',
      body: quotes.map((q) => `"${q.text}"`).join(' '),
      evidence: quotes.map((q) => q.id),
    });
  }
  if (sections.length === 0) {
    const fallback = insights[0];
    sections.push({
      heading: isArabic ? 'ملخص' : 'Summary',
      body: fallback.text,
      evidence: [fallback.id],
    });
  }

  const unsupportedClaims = claims.map((claim) => ({
    text: claim.text,
    note: isArabic
      ? 'رقم ذكره المتحدث فقط؛ يحتاج إلى تحقق تحريري قبل النشر كحقيقة مؤكدة.'
      : 'Speaker-stated figure only; needs editorial verification before publishing as a confirmed fact.',
  }));

  return {
    title: isArabic ? `[مسودة] ${truncate(brief.thesis.text, 80)}` : `[Draft] ${truncate(brief.thesis.text, 80)}`,
    introduction: brief.thesis.text,
    sections,
    conclusion: isArabic
      ? 'هذا ملخص تجريبي وليس محتوى نهائيًا جاهزًا للنشر.'
      : 'This is a mock draft, not finished, publish-ready content.',
    callToAction: cta ? { text: cta.text, evidence: [cta.id] } : null,
    unsupportedClaims,
  };
}

function buildSocialDraft(input: ContentGenerationInput, isArabic: boolean) {
  const { insights, brief, settings } = input;
  const hook = byType(insights, 'hook')[0] ?? insights[0];
  const quote = byType(insights, 'quote')[0] ?? insights[0];
  const cta = byType(insights, 'call_to_action')[0];

  let body: string;
  let hashtags: string[] = [];

  if (settings.platform === 'x') {
    body = truncate(quote.text, 220);
  } else if (settings.platform === 'linkedin') {
    body = isArabic
      ? `[منشور تجريبي] ${quote.text}\n\n${brief.thesis.text}`
      : `[mock LinkedIn draft] ${quote.text}\n\n${brief.thesis.text}`;
  } else {
    body = isArabic ? `[تعليق تجريبي] ${quote.text}` : `[mock caption] ${quote.text}`;
    hashtags = isArabic ? ['#محتوى', '#نمو'] : ['#content', '#growth'];
  }

  const evidence = [...new Set([hook.id, quote.id, ...(cta ? [cta.id] : [])])];

  return {
    title: `${settings.platform ?? 'social'} draft`,
    hook: hook.text,
    body,
    callToAction: cta ? cta.text : null,
    hashtags,
    evidence,
    unsupportedClaims: [],
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
