import { db } from '../db';
import { assertEntitlement, assertPlatformLimit, recordUsage } from '../entitlements';
import { enqueuePipelineJob } from '../queue';
import { getContentProviders } from './index';
import type {
  GenerationArtifactType,
  SocialPlatform,
  SupportedLanguage,
} from '../../src/domain/schemas';

export class NoEditorialBriefError extends Error {
  status = 409;
  constructor(projectId: string) {
    super(`Project ${projectId} has no Editorial Brief yet — run insight extraction first.`);
  }
}

interface EnqueueGenerationParams {
  workspaceId: string;
  projectId: string;
  artifactType: GenerationArtifactType;
  platform: SocialPlatform | null;
  language: SupportedLanguage;
  tone: string;
  audience: string;
  dialect?: string;
  // Set by the regenerate endpoint to the artifact's current version ID
  // (or "initial" if it has none yet). An explicit regenerate must
  // always attempt a new version even with byte-identical settings —
  // that's the whole point of clicking the button — so its key can't
  // collide with the request that produced the version being
  // regenerated from. Once that new version lands, currentVersionId
  // changes, so a second identical regenerate click is a fresh key
  // too; two rapid clicks before the first finishes still collide
  // deliberately, which is desirable (a debounce, not a bug).
  regenerateFrom?: string;
}

function sanitizeForJobId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

/**
 * Shared by POST /api/v1/projects/{id}/content and
 * POST /api/v1/artifacts/{id}/regenerate: checks entitlement, computes
 * the idempotency key (folds in every setting that affects output,
 * the specific brief version, and the provider — so a changed setting
 * or a regenerated brief produces a new version, while an identical
 * re-request reuses the same job), and enqueues the generation job.
 */
export async function enqueueGenerationJob(params: EnqueueGenerationParams): Promise<{ jobId: string }> {
  const { workspaceId, projectId, artifactType, platform, language, tone, audience, dialect, regenerateFrom } = params;

  const briefArtifact = await db.contentArtifact.findFirst({
    where: { projectId, type: 'editorial_brief' },
    select: { currentVersionId: true },
  });
  if (!briefArtifact?.currentVersionId) {
    throw new NoEditorialBriefError(projectId);
  }

  await assertEntitlement(workspaceId, 'generation_call', 1);
  // "One social platform only" (free trial). Checked here so every
  // caller — the content endpoint, regenerate, and any future direct
  // API request — goes through the same server-side gate.
  await assertPlatformLimit(workspaceId, projectId, platform);

  const { primary } = getContentProviders();
  const idempotencyKey = [
    'generate',
    projectId,
    artifactType,
    platform ?? 'none',
    language,
    sanitizeForJobId(tone),
    sanitizeForJobId(audience) || 'any',
    sanitizeForJobId(dialect ?? '') || 'std',
    briefArtifact.currentVersionId,
    sanitizeForJobId(primary.name),
    ...(regenerateFrom ? ['regen', sanitizeForJobId(regenerateFrom)] : []),
  ].join('-');

  const job = await enqueuePipelineJob({
    workspaceId,
    projectId,
    type: 'generation',
    idempotencyKey,
    data: { projectId, artifactType, platform, language, tone, audience, dialect },
  });

  await recordUsage(workspaceId, 'generation_call', 1, idempotencyKey);

  return { jobId: job.id };
}
