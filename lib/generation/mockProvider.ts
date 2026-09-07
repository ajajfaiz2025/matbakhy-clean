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

/**
 * Platform-aware generation (P1 fix, quality-gate section B): X,
 * LinkedIn, and Instagram get genuinely different editorial treatment
 * — different anchor insight types, different structure, different CTA
 * policy, different hashtag conventions — not the same draft with
 * different character limits pasted on top. Each builder is
 * deterministic so it's testable without a real LLM.
 */
function buildSocialDraft(input: ContentGenerationInput, isArabic: boolean) {
  const { settings } = input;
  switch (settings.platform) {
    case 'x':
      return buildXDraft(input, isArabic);
    case 'linkedin':
      return buildLinkedInDraft(input, isArabic);
    case 'instagram':
      return buildInstagramDraft(input, isArabic);
    default:
      throw new Error(`Social/caption generation requires a platform, got: ${String(settings.platform)}`);
  }
}

function pickInsight(insights: InsightSummary[], types: string[]): InsightSummary {
  for (const type of types) {
    const found = byType(insights, type)[0];
    if (found) return found;
  }
  return insights[0];
}

// X: hook-first, single sharp thought, terse, no storytelling. A CTA
// is only included when the brief actually surfaced one — X posts
// don't manufacture "comment below" filler — and even then it stays
// as short as the hook itself. One hashtag at most.
function buildXDraft(input: ContentGenerationInput, isArabic: boolean) {
  const { insights } = input;
  const hookInsight = pickInsight(insights, ['hook', 'claim', 'quote']);
  const supportInsight = pickInsight(insights, ['key_point', 'theme']);
  const ctaInsight = byType(insights, 'call_to_action')[0];

  const hook = truncate(hookInsight.text, 140);
  const support =
    supportInsight.id !== hookInsight.id ? truncate(supportInsight.text, 100) : '';
  const body = truncate([hook, support].filter(Boolean).join(' — '), 260);

  const evidence = [...new Set([hookInsight.id, supportInsight.id, ...(ctaInsight ? [ctaInsight.id] : [])])];

  return {
    title: 'x draft',
    hook,
    body,
    callToAction: ctaInsight ? truncate(ctaInsight.text, 60) : null,
    hashtags: isArabic ? ['#نمو'] : ['#growth'],
    evidence,
    unsupportedClaims: [],
  };
}

// LinkedIn: a hook, a short narrative paragraph grounded in the
// thesis, a structured bullet list of key points, and a
// discussion-inviting CTA — the professional long-form shape, not a
// truncated tweet.
function buildLinkedInDraft(input: ContentGenerationInput, isArabic: boolean) {
  const { insights, brief } = input;
  const hookInsight = pickInsight(insights, ['claim', 'theme', 'hook']);
  const keyPoints = byType(insights, 'key_point').slice(0, 3);
  const points = keyPoints.length > 0 ? keyPoints : [pickInsight(insights, ['theme', 'quote'])];
  const ctaInsight = byType(insights, 'call_to_action')[0];

  const bulletList = points.map((point) => `• ${point.text}`).join('\n');
  const body = `${brief.thesis.text}\n\n${bulletList}`;

  const callToAction = ctaInsight
    ? isArabic
      ? `${ctaInsight.text} شاركونا رأيكم وتجربتكم في التعليقات.`
      : `${ctaInsight.text} What's your experience with this? Share it in the comments.`
    : isArabic
      ? 'ما رأيكم؟ أنا مهتم بمعرفة تجربتكم في التعليقات.'
      : "What's your take on this? I'd love to hear your experience in the comments.";

  const evidence = [
    ...new Set([hookInsight.id, ...points.map((point) => point.id), ...(ctaInsight ? [ctaInsight.id] : [])]),
  ];

  return {
    title: 'linkedin draft',
    hook: truncate(hookInsight.text, 150),
    body,
    callToAction,
    hashtags: isArabic
      ? ['#قيادة', '#نمو_الأعمال', '#تطوير_المحتوى']
      : ['#Leadership', '#GrowthStrategy', '#ContentStrategy'],
    evidence,
    unsupportedClaims: [],
  };
}

// Instagram: emotional/relatable hook with emoji, short storytelling
// caption anchored on a quote, an engagement-driven CTA (save/tag/
// share rather than "comment"), and a heavier, casual hashtag block.
function buildInstagramDraft(input: ContentGenerationInput, isArabic: boolean) {
  const { insights } = input;
  const hookInsight = pickInsight(insights, ['quote', 'hook']);
  const themeInsight = pickInsight(insights, ['theme', 'key_point']);
  const ctaInsight = byType(insights, 'call_to_action')[0];

  const hook = `✨ ${truncate(hookInsight.text, 120)}`;
  const body = `${hook}\n\n${themeInsight.text} 💬`;

  const callToAction = ctaInsight
    ? isArabic
      ? `${ctaInsight.text} 📌 احفظ هذا المنشور!`
      : `${ctaInsight.text} 📌 Save this post for later!`
    : isArabic
      ? 'احفظ هذا المنشور وشاركه مع صديق يحتاجه! 📌'
      : 'Save this post and tag a friend who needs to see this! 📌';

  const evidence = [...new Set([hookInsight.id, themeInsight.id, ...(ctaInsight ? [ctaInsight.id] : [])])];

  return {
    title: 'instagram draft',
    hook,
    body,
    callToAction,
    hashtags: isArabic
      ? ['#محتوى', '#نمو', '#إلهام', '#نصائح', '#تطوير_الذات', '#ريادة_اعمال']
      : ['#content', '#growth', '#inspiration', '#tips', '#mindset', '#entrepreneurship'],
    evidence,
    unsupportedClaims: [],
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
