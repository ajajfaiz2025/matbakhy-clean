import {
  blogDraftDataSchema,
  socialDraftDataSchema,
  type BlogDraftData,
  type SocialDraftData,
  type GroundingRef,
  type GenerationArtifactType,
} from '../../src/domain/schemas';
import type { InsightSummary } from './types';

export interface ValidationFailure {
  stage: 'schema' | 'grounding';
  errors: string[];
}

export type BlogValidationResult =
  | { valid: true; data: BlogDraftData; groundingMap: Record<string, GroundingRef> }
  | { valid: false; failure: ValidationFailure };

export type SocialValidationResult =
  | { valid: true; data: SocialDraftData; groundingMap: Record<string, GroundingRef> }
  | { valid: false; failure: ValidationFailure };

function toGroundingRef(insight: InsightSummary): GroundingRef {
  return {
    insightType: insight.type,
    text: insight.text,
    segmentIds: insight.segmentIds,
    startMs: insight.startMs,
    endMs: insight.endMs,
  };
}

function collectBlogEvidenceIds(data: BlogDraftData): string[] {
  const ids = new Set<string>();
  data.sections.forEach((section) => section.evidence.forEach((id) => ids.add(id)));
  if (data.callToAction) data.callToAction.evidence.forEach((id) => ids.add(id));
  return [...ids];
}

function collectSocialEvidenceIds(data: SocialDraftData): string[] {
  return [...new Set(data.evidence)];
}

// Every referenced insight ID must resolve to a real, persisted
// Insight row for this project (section 2: "do not allow the
// generation layer to invent factual claims not supported by the
// source material"). groundingMap is built here, mechanically, from
// real rows — never from whatever the provider claims.
function checkGrounding(
  referencedIds: string[],
  insights: InsightSummary[]
): { unknownIds: string[]; groundingMap: Record<string, GroundingRef> } {
  const byId = new Map(insights.map((insight) => [insight.id, insight]));
  const unknownIds = referencedIds.filter((id) => !byId.has(id));
  const groundingMap = Object.fromEntries(
    referencedIds.filter((id) => byId.has(id)).map((id) => [id, toGroundingRef(byId.get(id)!)])
  );
  return { unknownIds, groundingMap };
}

export function validateBlogDraft(raw: unknown, insights: InsightSummary[]): BlogValidationResult {
  const schemaResult = blogDraftDataSchema.safeParse(raw);
  if (!schemaResult.success) {
    return {
      valid: false,
      failure: {
        stage: 'schema',
        errors: schemaResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    };
  }

  const data = schemaResult.data;
  const { unknownIds, groundingMap } = checkGrounding(collectBlogEvidenceIds(data), insights);
  if (unknownIds.length > 0) {
    return {
      valid: false,
      failure: { stage: 'grounding', errors: unknownIds.map((id) => `evidence references unknown insight ID "${id}"`) },
    };
  }

  return { valid: true, data, groundingMap };
}

export function validateSocialDraft(raw: unknown, insights: InsightSummary[]): SocialValidationResult {
  const schemaResult = socialDraftDataSchema.safeParse(raw);
  if (!schemaResult.success) {
    return {
      valid: false,
      failure: {
        stage: 'schema',
        errors: schemaResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    };
  }

  const data = schemaResult.data;
  const { unknownIds, groundingMap } = checkGrounding(collectSocialEvidenceIds(data), insights);
  if (unknownIds.length > 0) {
    return {
      valid: false,
      failure: { stage: 'grounding', errors: unknownIds.map((id) => `evidence references unknown insight ID "${id}"`) },
    };
  }

  return { valid: true, data, groundingMap };
}

export function validateContentDraft(
  artifactType: GenerationArtifactType,
  raw: unknown,
  insights: InsightSummary[]
): BlogValidationResult | SocialValidationResult {
  return artifactType === 'blog_draft' ? validateBlogDraft(raw, insights) : validateSocialDraft(raw, insights);
}
