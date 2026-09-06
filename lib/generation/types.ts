import type { EditorialBrief, GenerationArtifactType, GenerationSettings, InsightType } from '../../src/domain/schemas';

export interface InsightSummary {
  id: string;
  type: InsightType;
  text: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
}

export interface ContentGenerationInput {
  artifactType: GenerationArtifactType;
  brief: EditorialBrief;
  // The real, persisted Insight rows for this project — the only
  // things a provider is allowed to cite as evidence.
  insights: InsightSummary[];
  settings: GenerationSettings;
}

/**
 * Provider abstraction (section 7): the orchestrator selects a model
 * per task rather than hard-coding one provider, and can fall back to
 * a secondary provider if the primary fails outright — not just on
 * validation failure, see lib/pipeline/generateContent.ts. A provider
 * returns raw, unvalidated JSON matching BlogDraftData (for
 * artifactType "blog_draft") or SocialDraftData (for "social_post" /
 * "caption").
 */
export interface ContentGenerationProvider {
  name: string;
  generate(input: ContentGenerationInput): Promise<unknown>;
  repair?(input: ContentGenerationInput, previousOutput: unknown, errors: string[]): Promise<unknown>;
}
