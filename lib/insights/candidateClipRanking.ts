import type { SupportedLanguage } from '../../src/domain/schemas';
import type { TranscriptSegmentInput } from './types';

/**
 * Deterministic candidate-clip ranking (P1 fix from the Product
 * Validation Report: "candidate selection currently relies on
 * simplistic logic such as the longest transcript sentence").
 *
 * This replaces "longest segment wins" with a multi-signal score over
 * windows of 1-3 consecutive transcript segments, so a clip can carry
 * a hook and its payoff instead of always being exactly one sentence.
 * No LLM is required or used — every signal below is computed from
 * the transcript text itself and from the already-extracted insights
 * (which are themselves grounded, validated data, not a fresh guess).
 *
 * Deliberately NOT a general ranking platform: five scored components
 * cover the eight signals named in the spec by combining the ones
 * that are, in practice, the same underlying evidence:
 *   - suitableDuration        -> "suitable duration"
 *   - valueDensity            -> "insight/value density" + "completeness"
 *                                (grounded in the same quotes/claims/
 *                                key points/CTA the brief already extracted)
 *   - independence            -> "strong standalone idea" + "contextual
 *                                independence" (does the window open on
 *                                its own thought, not mid-continuation,
 *                                and is it not the show's own greeting/intro)
 *   - quotability              -> "quotability" (length sweet spot + a
 *                                concrete, quotable marker)
 *   - curiosityEmotion         -> "curiosity" + "emotional relevance"
 *                                (a stat, a turn, a superlative)
 */

export interface CandidateClipCandidate {
  id: string;
  startMs: number;
  endMs: number;
  rationale: string;
  evidence: string[];
}

interface Window {
  segments: TranscriptSegmentInput[];
  startMs: number;
  endMs: number;
  text: string;
}

interface WindowScores {
  duration: number;
  density: number;
  independence: number;
  quotability: number;
  curiosityEmotion: number;
  greetingPenalty: number;
  total: number;
}

const MARKERS = {
  ar: {
    greeting: ['مرحبا', 'أهلا', 'اهلا', 'أهلاً', 'في هذه الحلقة', 'بنتكلم اليوم', 'اليوم بنتكلم', 'سنتحدث اليوم', 'اليوم سنتحدث', 'أهلاً وسهلاً'],
    continuation: ['بس', 'لكن', 'يعني', 'أيضا', 'ايضا', 'كذلك', 'وبعدين', 'بعدين'],
    transformation: ['تضاعف', 'زاد', 'ارتفع', 'نزل', 'انخفض', 'وصل', 'تحسن', 'تراجع'],
    superlative: ['أهم', 'أكبر', 'أول مرة', 'أبداً', 'ابدا', 'أفضل', 'الأفضل'],
    contrast: ['بس', 'لكن', 'رغم', 'مع ذلك'],
  },
  en: {
    greeting: ['welcome', 'hi everyone', 'hello', 'today we', "today we're", 'in this episode'],
    continuation: ['but', 'and', 'so', 'because', 'also', 'then', 'however'],
    transformation: ['doubled', 'tripled', 'increased', 'dropped', 'grew', 'fell', 'jumped', 'rose'],
    superlative: ['biggest', 'best', 'worst', 'never', 'always', 'first time', 'most'],
    contrast: ['but', 'however', 'yet'],
  },
} as const;

function startsWithAny(text: string, phrases: readonly string[]): boolean {
  const normalized = text.trim().toLowerCase();
  return phrases.some((phrase) => normalized.startsWith(phrase.toLowerCase()));
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return phrases.some((phrase) => normalized.includes(phrase.toLowerCase()));
}

function buildWindows(segments: TranscriptSegmentInput[], maxSpan: number): Window[] {
  const windows: Window[] = [];
  for (let start = 0; start < segments.length; start++) {
    for (let span = 1; span <= maxSpan && start + span <= segments.length; span++) {
      const slice = segments.slice(start, start + span);
      windows.push({
        segments: slice,
        startMs: slice[0].startMs,
        endMs: slice[slice.length - 1].endMs,
        text: slice.map((s) => s.text).join(' '),
      });
    }
  }
  return windows;
}

function scoreDuration(durationMs: number): number {
  const s = durationMs / 1000;
  if (s < 4) return 0.15;
  if (s <= 30) return 1.0;
  if (s <= 45) return 0.7;
  if (s <= 75) return 0.4;
  return 0.15;
}

function scoreDensity(window: Window, valueWeights: Map<string, number>): number {
  const total = window.segments.reduce((sum, seg) => sum + (valueWeights.get(seg.id) ?? 0), 0);
  const avg = total / window.segments.length;
  return Math.min(1, avg / 3); // weight of 3 (a quote/claim) saturates the score
}

function scoreIndependence(window: Window, isFirstSegmentOfTranscript: boolean, m: (typeof MARKERS)['ar' | 'en']): number {
  const openingText = window.segments[0].text;
  if (isFirstSegmentOfTranscript && containsAny(openingText, m.greeting)) return 0.1;
  if (startsWithAny(openingText, m.continuation)) return 0.35;
  return 1.0;
}

function scoreQuotability(window: Window, m: (typeof MARKERS)['ar' | 'en']): number {
  const lengthOk = window.segments.length <= 2 && window.text.length >= 20 && window.text.length <= 220;
  const hasConcreteMarker = /\d/.test(window.text) || containsAny(window.text, m.transformation) || containsAny(window.text, m.superlative);
  if (lengthOk && hasConcreteMarker) return 1.0;
  if (lengthOk || hasConcreteMarker) return 0.6;
  return 0.3;
}

function scoreCuriosityEmotion(window: Window, m: (typeof MARKERS)['ar' | 'en']): number {
  let score = 0;
  if (/\d/.test(window.text)) score += 0.4;
  if (containsAny(window.text, m.transformation)) score += 0.3;
  if (containsAny(window.text, m.superlative)) score += 0.2;
  if (containsAny(window.text, m.contrast)) score += 0.1;
  return Math.min(1, score);
}

function scoreWindow(
  window: Window,
  valueWeights: Map<string, number>,
  isFirstSegmentOfTranscript: boolean,
  m: (typeof MARKERS)['ar' | 'en']
): WindowScores {
  const duration = scoreDuration(window.endMs - window.startMs);
  const density = scoreDensity(window, valueWeights);
  const independence = scoreIndependence(window, isFirstSegmentOfTranscript, m);
  const quotability = scoreQuotability(window, m);
  const curiosityEmotion = scoreCuriosityEmotion(window, m);
  const greetingPenalty = isFirstSegmentOfTranscript && containsAny(window.segments[0].text, m.greeting) ? 0.15 : 1;

  const base = 0.25 * duration + 0.3 * density + 0.2 * independence + 0.15 * quotability + 0.1 * curiosityEmotion;
  return { duration, density, independence, quotability, curiosityEmotion, greetingPenalty, total: base * greetingPenalty };
}

function describeTopSignals(scores: WindowScores, language: SupportedLanguage): string {
  const named: Array<[string, number]> = [
    [language === 'ar' ? 'كثافة معلومات عالية' : 'high value density', scores.density],
    [language === 'ar' ? 'فكرة مستقلة وواضحة' : 'a clear, independent idea', scores.independence],
    [language === 'ar' ? 'قابلة للاقتباس' : 'quotable on its own', scores.quotability],
    [language === 'ar' ? 'لحظة مثيرة للفضول' : 'a curiosity-worthy moment', scores.curiosityEmotion],
    [language === 'ar' ? 'مدة مناسبة لمقطع قصير' : 'a suitable short-form duration', scores.duration],
  ];
  const top = named.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label]) => label);
  return language === 'ar' ? `الأعلى تسجيلاً: ${top.join(' + ')}` : `Top-ranked for: ${top.join(' + ')}`;
}

/**
 * Ranks candidate clips deterministically and returns up to
 * `maxClips`, highest score first, with no two candidates sharing a
 * transcript segment (so the list is genuinely distinct choices, not
 * near-duplicates of the same moment).
 */
export function rankCandidateClips(
  segments: TranscriptSegmentInput[],
  valueWeights: Map<string, number>,
  language: SupportedLanguage,
  maxClips = 3
): CandidateClipCandidate[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const firstSegmentId = sorted[0].id;
  const m = MARKERS[language];

  const windows = buildWindows(sorted, Math.min(3, sorted.length));
  const scored = windows
    .map((window) => ({
      window,
      scores: scoreWindow(window, valueWeights, window.segments[0].id === firstSegmentId, m),
    }))
    .sort((a, b) => b.scores.total - a.scores.total);

  const selected: typeof scored = [];
  const usedSegmentIds = new Set<string>();
  for (const candidate of scored) {
    if (candidate.window.segments.some((seg) => usedSegmentIds.has(seg.id))) continue;
    selected.push(candidate);
    candidate.window.segments.forEach((seg) => usedSegmentIds.add(seg.id));
    if (selected.length >= maxClips) break;
  }

  return selected.map((candidate, index) => ({
    id: `clip_${index + 1}`,
    startMs: candidate.window.startMs,
    endMs: candidate.window.endMs,
    rationale: describeTopSignals(candidate.scores, language),
    evidence: candidate.window.segments.map((seg) => seg.id),
  }));
}

/**
 * Builds the per-segment value-weight map ranking draws on, from
 * insight items already extracted in the same pass (quotes/claims are
 * the strongest "this is worth quoting" signal available without an
 * LLM; themes are the weakest, being broad summaries rather than
 * single moments).
 */
export function buildValueWeights(items: {
  quotes: Array<{ evidence: string[] }>;
  claims: Array<{ evidence: string[] }>;
  keyPoints: Array<{ evidence: string[] }>;
  hooks: Array<{ evidence: string[] }>;
  themes: Array<{ evidence: string[] }>;
  callToAction: { evidence: string[] } | null;
}): Map<string, number> {
  const weights = new Map<string, number>();
  const bump = (evidenceLists: string[][], amount: number) => {
    for (const ids of evidenceLists) {
      for (const id of ids) weights.set(id, (weights.get(id) ?? 0) + amount);
    }
  };
  bump(items.quotes.map((q) => q.evidence), 3);
  bump(items.claims.map((c) => c.evidence), 3);
  bump(items.keyPoints.map((k) => k.evidence), 2);
  bump(items.hooks.map((h) => h.evidence), 2);
  if (items.callToAction) bump([items.callToAction.evidence], 1);
  bump(items.themes.map((t) => t.evidence), 1);
  return weights;
}
