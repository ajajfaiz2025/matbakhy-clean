import type { EditorialBrief, EditorialBriefDraft, SupportedLanguage } from '../../src/domain/schemas';

/**
 * Deterministic fallback synthesis for the "global reconciliation"
 * step — used when a provider doesn't implement reconcile(). Merges N
 * already-validated, chunk-scoped Editorial Briefs into one draft by
 * concatenation. Each item's transient "id" field is namespaced by
 * chunk index (these are just local labels inside the JSON for
 * cross-referencing within one brief, not the persisted Insight.id
 * generated later at save time, so rewriting them here is safe and
 * just keeps duplicates like two chunks each producing "theme_1"
 * distinguishable). No LLM call — this keeps "don't unnecessarily
 * increase LLM calls" true even for a provider without real
 * synthesis; a provider that implements reconcile() can do better.
 */
export function deterministicReconcile(
  localBriefs: EditorialBrief[],
  language: SupportedLanguage,
  audience: string
): EditorialBriefDraft {
  const namespaced = <T extends { id: string }>(items: T[], chunkIndex: number): T[] =>
    items.map((item) => ({ ...item, id: `c${chunkIndex}_${item.id}` }));

  return {
    thesis: localBriefs[0].thesis,
    audience,
    language,
    themes: localBriefs.flatMap((brief, i) => namespaced(brief.themes, i)),
    keyPoints: localBriefs.flatMap((brief, i) => namespaced(brief.keyPoints, i)),
    quotes: localBriefs.flatMap((brief, i) => namespaced(brief.quotes, i)),
    hooks: localBriefs.flatMap((brief, i) => namespaced(brief.hooks, i)),
    candidateClips: localBriefs.flatMap((brief, i) => namespaced(brief.candidateClips, i)),
    claims: localBriefs.flatMap((brief, i) => namespaced(brief.claims, i)),
    callToAction: localBriefs.map((brief) => brief.callToAction).find((cta) => cta !== null) ?? null,
    confidenceNotes: `Reconciled deterministically from ${localBriefs.length} transcript chunks (no LLM synthesis call).`,
  };
}
