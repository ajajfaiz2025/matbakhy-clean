import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { recordUsage } from '../entitlements';
import { storage } from '../storage';
import { RENDER_CONFIG, getFfmpegTimeoutMs } from '../rendering/config';
import { buildCaptionCues, writeAssFile } from '../rendering/captions';
import { probeMedia, runSubprocess } from '../rendering/ffmpeg';
import { editorialBriefSchema, type EditorialBrief, type ShortVideoArtifactBody } from '../../src/domain/schemas';

interface RenderShortVideoData {
  renderJobId: string;
  artifactId: string;
  projectId: string;
  candidateClipId: string;
  sourceBriefVersionId: string;
  sourceMediaId: string;
}

function computeChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Escapes a local filesystem path for use as an ffmpeg filtergraph
// filter argument (subtitles=<path>), where ':' and '\' are
// structurally significant and single-quoting the value requires
// escaping any literal single quote it might contain.
function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

async function markFailed(renderJobId: string, isLastAttempt: boolean, message: string): Promise<void> {
  await db.renderJob
    .update({
      where: { id: renderJobId },
      data: { status: isLastAttempt ? 'dead_letter' : 'retrying', error: message.slice(0, 2000) },
    })
    .catch((error) => console.error(`Failed to record render failure for ${renderJobId}:`, error));
}

/**
 * Render worker (Step 8): CandidateClip -> FFmpeg extraction -> 9:16
 * scale-and-center-crop -> caption burn-in -> rendered MediaFile ->
 * short_video ContentArtifact. Reads the pinned Editorial Brief
 * VERSION (sourceBriefVersionId), not "whatever the brief currently
 * is" — a later brief regeneration cannot silently change what this
 * render is grounded in. Same two-stage failure handling as every
 * other pipeline handler: throw to let BullMQ's existing retry/backoff
 * run, updating the domain-specific RenderJob row alongside the
 * generic PipelineJob row that startPipelineWorker already maintains.
 */
export async function renderShortVideo(job: Job<RenderShortVideoData>): Promise<void> {
  const { renderJobId, artifactId, projectId, candidateClipId, sourceBriefVersionId, sourceMediaId } = job.data;
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const idempotencyKey = job.id!;

  const workDir = await mkdtemp(path.join(tmpdir(), `render-${renderJobId}-`));
  const assPath = path.join(workDir, 'captions.ass');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    const renderJobRow = await db.renderJob.update({
      where: { id: renderJobId },
      data: { status: 'running', error: null },
    });
    const workspaceId = renderJobRow.workspaceId;

    const briefVersion = await db.artifactVersion.findUnique({ where: { id: sourceBriefVersionId } });
    if (!briefVersion) {
      throw new Error(`Editorial Brief version ${sourceBriefVersionId} no longer exists.`);
    }
    const brief: EditorialBrief = editorialBriefSchema.parse(briefVersion.body);
    const clip = brief.candidateClips.find((c) => c.id === candidateClipId);
    if (!clip) {
      throw new Error(`Candidate clip "${candidateClipId}" is not present in Editorial Brief version ${sourceBriefVersionId}.`);
    }

    const sourceMedia = await db.mediaFile.findUniqueOrThrow({ where: { id: sourceMediaId } });
    const sourcePath = storage.resolve(sourceMedia.storageKey);
    try {
      await stat(sourcePath);
    } catch {
      throw new Error(`Source media file is missing from storage at key "${sourceMedia.storageKey}".`);
    }

    const timeoutMs = getFfmpegTimeoutMs();
    const sourceProbe = await probeMedia(sourcePath, timeoutMs);

    if (clip.startMs >= sourceProbe.durationMs) {
      throw new Error(
        `Candidate clip starts at ${clip.startMs}ms, at or past the source's actual duration (${sourceProbe.durationMs}ms).`
      );
    }
    // Insufficient source duration is handled gracefully: clamp to what
    // actually exists rather than failing (section 3/12), and record
    // that fact rather than pretending nothing was clamped.
    const effectiveEndMs = Math.min(clip.endMs, sourceProbe.durationMs);
    const clipDurationMs = effectiveEndMs - clip.startMs;
    const sourceUpscaled = Boolean(
      sourceProbe.width && sourceProbe.height && (sourceProbe.width < RENDER_CONFIG.width || sourceProbe.height < RENDER_CONFIG.height)
    );

    const segments = await db.transcriptSegment.findMany({
      where: { transcript: { projectId }, startMs: { lt: effectiveEndMs }, endMs: { gt: clip.startMs } },
      orderBy: { startMs: 'asc' },
    });
    const cues = buildCaptionCues(
      segments.map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text })),
      clip.startMs,
      effectiveEndMs
    );
    const hasCaptions = cues.length > 0;
    if (hasCaptions) {
      await writeAssFile(assPath, cues, RENDER_CONFIG);
    }

    const startSeconds = (clip.startMs / 1000).toFixed(3);
    const durationSeconds = (clipDurationMs / 1000).toFixed(3);
    const filters = [
      `scale=${RENDER_CONFIG.width}:${RENDER_CONFIG.height}:force_original_aspect_ratio=increase`,
      `crop=${RENDER_CONFIG.width}:${RENDER_CONFIG.height}`,
    ];
    if (hasCaptions) {
      filters.push(`subtitles='${escapeFilterPath(assPath)}'`);
    }

    const args = [
      '-y',
      '-ss', startSeconds,
      '-i', sourcePath,
      '-t', durationSeconds,
      '-vf', filters.join(','),
      '-map', '0:v:0',
      ...(sourceProbe.hasAudio ? ['-map', '0:a:0'] : []),
      '-r', String(RENDER_CONFIG.fps),
      '-c:v', RENDER_CONFIG.videoCodec,
      '-preset', 'veryfast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      ...(sourceProbe.hasAudio ? ['-c:a', RENDER_CONFIG.audioCodec ?? 'aac', '-b:a', '128k', '-ac', '2'] : []),
      '-movflags', '+faststart',
      outputPath,
    ];

    const renderStartedAt = Date.now();
    await runSubprocess('ffmpeg', args, timeoutMs);
    const renderDurationMs = Date.now() - renderStartedAt;

    const outputStat = await stat(outputPath).catch(() => null);
    if (!outputStat || outputStat.size === 0) {
      throw new Error('FFmpeg reported success but produced no output file.');
    }

    const outputProbe = await probeMedia(outputPath, timeoutMs);
    const checksum = await computeChecksum(outputPath);

    const renderedStorageKey = `${workspaceId}/rendered/${randomUUID()}.mp4`;
    await storage.writeLocalFile(renderedStorageKey, outputPath);

    const mediaFile = await db.mediaFile.create({
      data: {
        workspaceId,
        kind: 'rendered',
        storageKey: renderedStorageKey,
        mimeType: 'video/mp4',
        durationMs: outputProbe.durationMs,
        checksum,
        status: 'normalized',
      },
    });

    const body: ShortVideoArtifactBody = {
      kind: 'short_video',
      title: `Short: ${clip.rationale.slice(0, 60)}${clip.rationale.length > 60 ? '…' : ''}`,
      candidateClipId,
      sourceBriefVersionId,
      renderJobId,
      mediaFileId: mediaFile.id,
      language: brief.language,
      config: RENDER_CONFIG,
      output: {
        durationMs: outputProbe.durationMs,
        width: outputProbe.width ?? RENDER_CONFIG.width,
        height: outputProbe.height ?? RENDER_CONFIG.height,
        videoCodec: outputProbe.videoCodec ?? RENDER_CONFIG.videoCodec,
        audioCodec: outputProbe.audioCodec,
        hasAudio: outputProbe.hasAudio,
        fileSizeBytes: outputStat.size,
      },
      hasCaptions,
      sourceUpscaled,
      evidence: [...new Set([...clip.evidence, ...cues.map((c) => c.segmentId)])],
      clipRationale: clip.rationale,
      performance: {
        sourceDurationMs: clipDurationMs,
        renderDurationMs,
        processingRatio: outputProbe.durationMs > 0 ? renderDurationMs / outputProbe.durationMs : 0,
      },
    };

    await db.$transaction(async (tx) => {
      const version = await tx.artifactVersion.create({
        data: {
          artifactId,
          sourceBriefVersionId,
          tier: 'paid',
          body: body as unknown as Prisma.InputJsonValue,
          parameters: { candidateClipId } as unknown as Prisma.InputJsonValue,
          model: `ffmpeg:${RENDER_CONFIG.templateVersion}`,
          createdBy: 'pipeline:render',
        },
      });
      await tx.contentArtifact.update({ where: { id: artifactId }, data: { status: 'ready', currentVersionId: version.id } });
      await tx.renderJob.update({
        where: { id: renderJobId },
        data: { status: 'succeeded', progress: 1, outputMediaId: mediaFile.id, error: null },
      });
    });

    await recordUsage(workspaceId, 'render_minutes', outputProbe.durationMs / 60_000, idempotencyKey);
  } catch (error) {
    await markFailed(renderJobId, isLastAttempt, error instanceof Error ? error.message : String(error));
    if (isLastAttempt) {
      await db.contentArtifact.update({ where: { id: artifactId }, data: { status: 'failed' } }).catch(() => {});
    }
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
