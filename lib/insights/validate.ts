import {
  editorialBriefDraftSchema,
  editorialBriefSchema,
  type EditorialBrief,
  type EditorialBriefDraft,
} from '../../src/domain/schemas';
import type { TranscriptSegmentInput } from './types';

export interface ValidationFailure {
  stage: 'schema' | 'grounding';
  errors: string[];
}

export type ValidationResult = { valid: true; brief: EditorialBrief } | { valid: false; failure: ValidationFailure };

function collectEvidenceIds(draft: EditorialBriefDraft): string[] {
  const ids = new Set<string>();
  const add = (evidence: string[]) => evidence.forEach((id) => ids.add(id));

  add(draft.thesis.evidence);
  draft.themes.forEach((theme) => add(theme.evidence));
  draft.keyPoints.forEach((keyPoint) => add(keyPoint.evidence));
  draft.quotes.forEach((quote) => add(quote.evidence));
  draft.hooks.forEach((hook) => add(hook.evidence));
  draft.candidateClips.forEach((clip) => add(clip.evidence));
  draft.claims.forEach((claim) => add(claim.evidence));
  if (draft.callToAction) add(draft.callToAction.evidence);

  return [...ids];
}

/**
 * Validates a raw provider output in two layers (section 6.4.7):
 * schema first (cheap, deterministic), then grounding — every
 * referenced segment ID must exist in this project's transcript.
 * Neither layer silently repairs; callers get back exactly what's
 * wrong so the orchestrator can drive a single bounded repair attempt
 * (section 6.4.7's "one constrained repair, then fail").
 */
export function validateEditorialBrief(raw: unknown, segments: TranscriptSegmentInput[]): ValidationResult {
  const schemaResult = editorialBriefDraftSchema.safeParse(raw);
  if (!schemaResult.success) {
    return {
      valid: false,
      failure: {
        stage: 'schema',
        errors: schemaResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    };
  }

  const draft = schemaResult.data;
  const validSegmentIds = new Set(segments.map((segment) => segment.id));
  const referencedIds = collectEvidenceIds(draft);
  const unknownIds = referencedIds.filter((id) => !validSegmentIds.has(id));

  if (unknownIds.length > 0) {
    return {
      valid: false,
      failure: {
        stage: 'grounding',
        errors: unknownIds.map((id) => `evidence references unknown segment ID "${id}"`),
      },
    };
  }

  const evidenceMap = Object.fromEntries(
    referencedIds.map((id) => {
      const segment = segments.find((candidate) => candidate.id === id)!;
      return [
        id,
        { segmentIds: [segment.id], startMs: segment.startMs, endMs: segment.endMs, text: segment.text },
      ];
    })
  );

  // Should be unreachable given the draft already validated and
  // evidenceMap is built mechanically from real segments — but fail
  // loudly rather than persist something that doesn't match the
  // canonical schema if that assumption is ever wrong.
  const finalResult = editorialBriefSchema.safeParse({ ...draft, evidenceMap });
  if (!finalResult.success) {
    return {
      valid: false,
      failure: {
        stage: 'schema',
        errors: finalResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    };
  }

  return { valid: true, brief: finalResult.data };
}
