import type { EditorialBrief, SupportedLanguage } from '../../src/domain/schemas';

export interface TranscriptSegmentInput {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

export interface InsightExtractionInput {
  segments: TranscriptSegmentInput[];
  language: SupportedLanguage;
  audience: string;
}

/**
 * Provider abstraction (section 4.1 / 6.4.8): the orchestrator selects
 * a model by task/language/cost rather than hard-coding one provider,
 * so an Arabic-focused model (e.g. HUMAIN/ALLAM) can be routed to once
 * an API for it is available — see getInsightProvider() in ./index.ts.
 *
 * A provider returns raw, unvalidated JSON matching
 * EditorialBriefDraft's shape (i.e. everything except evidenceMap,
 * which the orchestrator derives itself). Schema and grounding
 * validation happen centrally in ./validate.ts so every provider is
 * checked the same way regardless of which model produced the output.
 */
export interface InsightExtractionProvider {
  name: string;
  extract(input: InsightExtractionInput): Promise<unknown>;
  // Optional: given the previous (invalid) output and a list of
  // validation/grounding errors, produce a corrected version. Providers
  // without a real repair capability can omit this — the orchestrator
  // falls back to calling extract() again.
  repair?(input: InsightExtractionInput, previousOutput: unknown, errors: string[]): Promise<unknown>;
  // Optional: for long transcripts split into chunks (see ./chunk.ts),
  // combine the already-validated, chunk-scoped local briefs into one
  // global draft. Providers without real synthesis can omit this — the
  // orchestrator falls back to a deterministic merge (./reconcile.ts).
  reconcile?(input: {
    localBriefs: EditorialBrief[];
    language: SupportedLanguage;
    audience: string;
  }): Promise<unknown>;
}
