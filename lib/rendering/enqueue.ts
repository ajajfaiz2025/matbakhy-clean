import { db } from '../db';
import { assertEntitlement } from '../entitlements';
import { enqueuePipelineJob } from '../queue';
import { RENDER_CONFIG, TEMPLATE_VERSION } from './config';
import { editorialBriefSchema, type EditorialCandidateClip } from '../../src/domain/schemas';

export class NoEditorialBriefError extends Error {
  status = 409;
  constructor(projectId: string) {
    super(`Project ${projectId} has no Editorial Brief yet — run insight extraction first.`);
  }
}

export class CandidateClipNotFoundError extends Error {
  status = 404;
  constructor(candidateClipId: string) {
    super(`Candidate clip "${candidateClipId}" was not found in the current Editorial Brief version.`);
  }
}

export class SourceMediaNotReadyError extends Error {
  status = 409;
  constructor(status: string) {
    super(`Source media is not ready to render from yet (status: ${status}).`);
  }
}

export class InvalidClipRangeError extends Error {
  status = 422;
  constructor(message: string) {
    super(message);
  }
}

interface EnqueueRenderJobParams {
  workspaceId: string;
  projectId: string;
  candidateClipId: string;
}

function msToMinutes(ms: number): number {
  return ms / 60_000;
}

/**
 * Resolves a candidateClip against the project's CURRENT Editorial
 * Brief version (Step 8, section 1: "the current Editorial Brief
 * version must remain the source of truth" — no re-discovery of clips,
 * no extra LLM pass here), pins that version's id into the render
 * job/artifact so a later brief regeneration cannot silently change
 * what an already-queued or already-rendered short video is grounded
 * in, checks the render_minutes entitlement, and enqueues the render
 * exactly like every other pipeline stage (idempotent PipelineJob +
 * BullMQ, same retry/backoff).
 */
export async function enqueueRenderJob(
  params: EnqueueRenderJobParams
): Promise<{ jobId: string; renderJobId: string; artifactId: string }> {
  const { workspaceId, projectId, candidateClipId } = params;

  const briefArtifact = await db.contentArtifact.findFirst({
    where: { projectId, type: 'editorial_brief' },
    include: { currentVersion: true },
  });
  if (!briefArtifact?.currentVersion) {
    throw new NoEditorialBriefError(projectId);
  }
  const brief = editorialBriefSchema.parse(briefArtifact.currentVersion.body);
  const sourceBriefVersionId = briefArtifact.currentVersion.id;

  const clip: EditorialCandidateClip | undefined = brief.candidateClips.find((c) => c.id === candidateClipId);
  if (!clip) {
    throw new CandidateClipNotFoundError(candidateClipId);
  }

  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.sourceMediaId) {
    throw new SourceMediaNotReadyError('missing');
  }
  const sourceMedia = await db.mediaFile.findUniqueOrThrow({ where: { id: project.sourceMediaId } });
  if (sourceMedia.status !== 'normalized') {
    throw new SourceMediaNotReadyError(sourceMedia.status);
  }
  if (clip.startMs >= clip.endMs) {
    throw new InvalidClipRangeError(`Candidate clip "${candidateClipId}" has an empty or inverted time range.`);
  }
  if (sourceMedia.durationMs != null && clip.startMs >= sourceMedia.durationMs) {
    throw new InvalidClipRangeError(
      `Candidate clip "${candidateClipId}" starts at ${clip.startMs}ms, at or past the source media's duration (${sourceMedia.durationMs}ms).`
    );
  }

  const estimatedMinutes = msToMinutes(clip.endMs - clip.startMs);
  await assertEntitlement(workspaceId, 'render_minutes', estimatedMinutes);

  const idempotencyKey = `render-${projectId}-${sourceBriefVersionId}-${candidateClipId}-${TEMPLATE_VERSION}`;

  const { artifact, renderJob } = await db.$transaction(async (tx) => {
    let contentArtifact = await tx.contentArtifact.findFirst({
      where: { projectId, type: 'short_video', sourceRefs: { has: candidateClipId } },
    });
    if (!contentArtifact) {
      contentArtifact = await tx.contentArtifact.create({
        data: {
          projectId,
          type: 'short_video',
          platform: null,
          language: brief.language,
          status: 'generating',
          sourceRefs: [candidateClipId],
        },
      });
    } else {
      await tx.contentArtifact.update({ where: { id: contentArtifact.id }, data: { status: 'generating' } });
    }

    const job = await tx.renderJob.upsert({
      where: { idempotencyKey },
      update: {},
      create: {
        workspaceId,
        projectId,
        artifactId: contentArtifact.id,
        candidateClipId,
        sourceBriefVersionId,
        sourceMediaId: sourceMedia.id,
        idempotencyKey,
        template: TEMPLATE_VERSION,
        config: RENDER_CONFIG,
        status: 'queued',
      },
    });

    return { artifact: contentArtifact, renderJob: job };
  });

  const pipelineJob = await enqueuePipelineJob({
    workspaceId,
    projectId,
    type: 'render',
    idempotencyKey,
    data: {
      renderJobId: renderJob.id,
      artifactId: artifact.id,
      projectId,
      candidateClipId,
      sourceBriefVersionId,
      sourceMediaId: sourceMedia.id,
    },
  });

  return { jobId: pipelineJob.id, renderJobId: renderJob.id, artifactId: artifact.id };
}
