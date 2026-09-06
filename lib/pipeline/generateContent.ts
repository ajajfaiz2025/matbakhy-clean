import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { getContentProviders, type ContentProviderSelection, type InsightSummary } from '../generation';
import { validateContentDraft } from '../generation/validate';
import type { ContentGenerationInput } from '../generation/types';
import {
  editorialBriefSchema,
  type BlogDraftData,
  type GenerationArtifactType,
  type GenerationSettings,
  type GroundingRef,
  type SocialDraftData,
  type SocialPlatform,
  type SupportedLanguage,
} from '../../src/domain/schemas';

interface GenerateContentData {
  projectId: string;
  artifactType: GenerationArtifactType;
  platform: SocialPlatform | null;
  language: SupportedLanguage;
  tone: string;
  audience: string;
  dialect?: string;
}

const MAX_REPAIR_ATTEMPTS = 1;

/**
 * Content-generation worker (section 3-4): compiles the project's
 * Editorial Brief + persisted Insight rows into a blog draft or a
 * platform-aware social post/caption. Same two-layer validation and
 * one-bounded-repair pattern as extractInsights (section 6.4.7) — an
 * ungrounded or malformed draft is never persisted. Falls back to a
 * secondary provider only when the primary provider fails outright
 * (network/auth/etc.), never to paper over a validation failure.
 */
export async function generateContent(
  job: Job<GenerateContentData>,
  providersOverride?: ContentProviderSelection
): Promise<void> {
  const { projectId, artifactType, platform, language, tone, audience, dialect } = job.data;

  const briefArtifact = await db.contentArtifact.findFirst({
    where: { projectId, type: 'editorial_brief' },
    include: { currentVersion: true },
  });
  if (!briefArtifact?.currentVersion) {
    throw new Error(`Project ${projectId} has no Editorial Brief to generate content from yet.`);
  }
  const brief = editorialBriefSchema.parse(briefArtifact.currentVersion.body);

  const insightRows = await db.insight.findMany({ where: { projectId } });
  const insights: InsightSummary[] = insightRows.map((row) => ({
    id: row.id,
    type: row.type,
    text: row.text,
    segmentIds: row.segmentIds,
    startMs: row.startMs,
    endMs: row.endMs,
  }));

  const settings: GenerationSettings = { tone, audience, language, dialect, platform };
  const generationInput: ContentGenerationInput = { artifactType, brief, insights, settings };

  const { primary, fallback } = providersOverride ?? getContentProviders();
  let provider = primary;
  let rawOutput: unknown;
  try {
    rawOutput = await primary.generate(generationInput);
  } catch (primaryError) {
    if (!fallback) throw primaryError;
    console.warn(`Primary content provider "${primary.name}" failed, falling back to "${fallback.name}":`, primaryError);
    provider = fallback;
    rawOutput = await fallback.generate(generationInput);
  }

  let result = validateContentDraft(artifactType, rawOutput, insights);
  let attempts = 0;
  while (!result.valid && attempts < MAX_REPAIR_ATTEMPTS) {
    attempts += 1;
    rawOutput = provider.repair
      ? await provider.repair(generationInput, rawOutput, result.failure.errors)
      : await provider.generate(generationInput);
    result = validateContentDraft(artifactType, rawOutput, insights);
  }

  if (!result.valid) {
    throw new Error(
      `Generated ${artifactType} failed ${result.failure.stage} validation after ${attempts} repair attempt(s): ${result.failure.errors.join('; ')}`
    );
  }

  await persistContentArtifact({
    projectId,
    artifactType,
    platform,
    language,
    settings,
    data: result.data,
    groundingMap: result.groundingMap,
    providerName: provider.name,
    sourceBriefVersionId: briefArtifact.currentVersion.id,
  });
}

async function persistContentArtifact(params: {
  projectId: string;
  artifactType: GenerationArtifactType;
  platform: SocialPlatform | null;
  language: SupportedLanguage;
  settings: GenerationSettings;
  data: BlogDraftData | SocialDraftData;
  groundingMap: Record<string, GroundingRef>;
  providerName: string;
  sourceBriefVersionId: string;
}) {
  const { projectId, artifactType, platform, language, settings, data, groundingMap, providerName, sourceBriefVersionId } =
    params;

  await db.$transaction(async (tx) => {
    let artifact = await tx.contentArtifact.findFirst({
      where: { projectId, type: artifactType, platform, language },
    });
    if (!artifact) {
      artifact = await tx.contentArtifact.create({
        data: { projectId, type: artifactType, platform, language, status: 'draft', sourceRefs: [] },
      });
    }

    const body =
      artifactType === 'blog_draft'
        ? { kind: 'blog_draft' as const, data: data as BlogDraftData, settings, groundingMap }
        : { kind: artifactType as 'social_post' | 'caption', data: data as SocialDraftData, settings, groundingMap };

    // Never overwrite a previous version — each successful run appends
    // a new immutable ArtifactVersion and repoints currentVersionId.
    const version = await tx.artifactVersion.create({
      data: {
        artifactId: artifact.id,
        sourceBriefVersionId,
        body: body as unknown as Prisma.InputJsonValue,
        parameters: { settings } as unknown as Prisma.InputJsonValue,
        model: providerName,
        createdBy: 'pipeline:generation',
      },
    });

    await tx.contentArtifact.update({
      where: { id: artifact.id },
      data: { status: 'ready', currentVersionId: version.id },
    });
  });
}
