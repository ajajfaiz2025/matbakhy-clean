import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../lib/db';
import { EntitlementError, recordUsage } from '../../lib/entitlements';
import { extractInsights } from '../../lib/pipeline/extractInsights';
import { renderShortVideo } from '../../lib/pipeline/renderShortVideo';
import { mockInsightProvider } from '../../lib/insights/mockProvider';
import {
  CandidateClipNotFoundError,
  InvalidClipRangeError,
  enqueueRenderJob,
} from '../../lib/rendering/enqueue';
import { probeMedia } from '../../lib/rendering/ffmpeg';
import { RENDER_CONFIG } from '../../lib/rendering/config';
import { pipelineQueue } from '../../lib/queue';
import { storage } from '../../lib/storage';
import { editorialBriefSchema, type ShortVideoArtifactBody } from '../../src/domain/schemas';
import { generateSyntheticVideo, hasRealFfmpeg } from '../rendering/fixtures';

interface SegmentFixture {
  text: string;
  startMs: number;
  endMs: number;
}

const EN_SEGMENTS: SegmentFixture[] = [
  { text: 'Welcome, today we discuss growth.', startMs: 0, endMs: 3000 },
  { text: 'When we started, we had just two customers and grew steadily every week.', startMs: 3000, endMs: 9000 },
  { text: 'Thanks for watching, subscribe for more.', startMs: 9000, endMs: 12000 },
];

const AR_SEGMENTS: SegmentFixture[] = [
  { text: 'أهلاً بكم اليوم نتحدث عن النمو.', startMs: 0, endMs: 3000 },
  { text: 'عندما بدأنا كان لدينا عميلان فقط ونمونا بثبات كل أسبوع بفضل التسويق الجيد.', startMs: 3000, endMs: 9000 },
  { text: 'شكراً لمشاهدتكم، يرجى الاشتراك.', startMs: 9000, endMs: 12000 },
];

async function setupRenderableProject(options: {
  language?: 'en' | 'ar';
  planId?: string;
  videoDurationSeconds?: number;
  videoWidth?: number;
  videoHeight?: number;
  withAudio?: boolean;
} = {}) {
  const {
    language = 'en',
    planId = 'creator',
    videoDurationSeconds = 14,
    videoWidth = 1280,
    videoHeight = 720,
    withAudio = true,
  } = options;

  const workspace = await db.workspace.create({
    data: { id: `test-ws-render-${randomUUID()}`, name: 'Render Test Workspace', planId },
  });

  const storageKey = `test/${randomUUID()}.mp4`;
  const localPath = storage.resolve(storageKey);
  await generateSyntheticVideo({
    outputPath: localPath,
    durationSeconds: videoDurationSeconds,
    width: videoWidth,
    height: videoHeight,
    withAudio,
  });
  const sourceProbe = await probeMedia(localPath, 30_000);

  const mediaFile = await db.mediaFile.create({
    data: {
      workspaceId: workspace.id,
      kind: 'source',
      storageKey,
      mimeType: 'video/mp4',
      status: 'normalized',
      durationMs: sourceProbe.durationMs,
      checksum: randomUUID(),
    },
  });

  const project = await db.project.create({
    data: { workspaceId: workspace.id, title: 'Render Test Project', sourceMediaId: mediaFile.id, status: 'ready' },
  });

  const segments = language === 'ar' ? AR_SEGMENTS : EN_SEGMENTS;
  await db.transcript.create({
    data: {
      projectId: project.id,
      provider: 'test-fixture',
      language,
      segments: { create: segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, speaker: null })) },
    },
  });

  await extractInsights(
    { data: { projectId: project.id, audience: '' } } as Parameters<typeof extractInsights>[0],
    mockInsightProvider
  );

  const briefArtifact = await db.contentArtifact.findFirstOrThrow({
    where: { projectId: project.id, type: 'editorial_brief' },
    include: { currentVersion: true },
  });
  const brief = editorialBriefSchema.parse(briefArtifact.currentVersion!.body);
  const candidateClipId = brief.candidateClips[0].id;

  return { workspace, mediaFile, project, brief, candidateClipId, sourceProbe };
}

type FakeRenderJob = Parameters<typeof renderShortVideo>[0];

function fakeJob(idempotencyKey: string, data: FakeRenderJob['data'], attemptsMade = 0): FakeRenderJob {
  return { id: idempotencyKey, data, attemptsMade, opts: { attempts: 5 } } as FakeRenderJob;
}

describe('Step 8 short-video rendering', () => {
  const workspaceIds: string[] = [];

  afterAll(async () => {
    // Every test here calls enqueueRenderJob (which adds a real BullMQ
    // job) and then invokes the handler directly rather than running an
    // actual worker — so the BullMQ job itself is never consumed. Clean
    // those up explicitly; otherwise a real worker started later would
    // pick up stale jobs whose DB rows this cleanup is about to delete.
    const pipelineRows = await db.pipelineJob.findMany({
      where: { workspaceId: { in: workspaceIds }, type: 'render' },
      select: { idempotencyKey: true },
    });
    await Promise.all(
      pipelineRows.map((row) => pipelineQueue.getJob(row.idempotencyKey).then((job) => job?.remove()).catch(() => {}))
    );
    await Promise.all(
      workspaceIds.map((id) => db.workspace.delete({ where: { id } }).catch(() => {}))
    );
    await pipelineQueue.close();
    await db.$disconnect();
  });

  describe('enqueueRenderJob (validation, no ffmpeg required)', () => {
    it('rejects a candidateClipId that does not exist in the current brief', async () => {
      const { workspace, project } = await setupRenderableProject();
      workspaceIds.push(workspace.id);

      await expect(
        enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId: 'does-not-exist' })
      ).rejects.toBeInstanceOf(CandidateClipNotFoundError);
    });

    it('rejects a clip whose start is at or past the source media duration', async () => {
      const { workspace, project, mediaFile } = await setupRenderableProject({ videoDurationSeconds: 2 });
      workspaceIds.push(workspace.id);

      // The candidate clip starts at 3000ms; this 2s source ends before that.
      expect(mediaFile.durationMs).toBeLessThan(3000);

      await expect(
        enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId: 'clip_1' })
      ).rejects.toBeInstanceOf(InvalidClipRangeError);
    });

    it('is idempotent: the same workspace/project/clip reuses the same job and RenderJob row', async () => {
      const { workspace, project, candidateClipId } = await setupRenderableProject();
      workspaceIds.push(workspace.id);

      const first = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const second = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });

      expect(second.jobId).toBe(first.jobId);
      expect(second.renderJobId).toBe(first.renderJobId);

      const rows = await db.renderJob.findMany({ where: { projectId: project.id } });
      expect(rows.length).toBe(1);
      const pipelineRows = await db.pipelineJob.findMany({ where: { projectId: project.id, type: 'render' } });
      expect(pipelineRows.length).toBe(1);

      const bullJob = await pipelineQueue.getJob(pipelineRows[0].idempotencyKey);
      await bullJob?.remove();
    });

    it('enforces render_minutes entitlement on the free plan', async () => {
      const { workspace, project, candidateClipId } = await setupRenderableProject({ planId: 'free' });
      workspaceIds.push(workspace.id);

      // Push usage to just under the free plan's 15-minute cap so the
      // ~6s (0.1min) candidate clip's estimate tips it over 15.
      await recordUsage(workspace.id, 'render_minutes', 14.95, `test-preload-${randomUUID()}`);

      await expect(
        enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId })
      ).rejects.toBeInstanceOf(EntitlementError);
    });

    it('allows a render within the free plan allowance', async () => {
      const { workspace, project, candidateClipId } = await setupRenderableProject({ planId: 'free' });
      workspaceIds.push(workspace.id);

      const result = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      expect(result.jobId).toBeTruthy();

      const bullJob = await pipelineQueue.getJob(
        (await db.pipelineJob.findFirstOrThrow({ where: { projectId: project.id, type: 'render' } })).idempotencyKey
      );
      await bullJob?.remove();
    });
  });

  describe('renderShortVideo worker (real FFmpeg)', () => {
    it('REAL FFMPEG VERIFIED: renders an English clip end-to-end into a grounded, versioned 9:16 MP4 artifact', async () => {
      if (!(await hasRealFfmpeg())) {
        console.warn('FFMPEG MOCKED (ffmpeg unavailable) — skipping real-render test.');
        return;
      }
      console.log('REAL FFMPEG VERIFIED — full renderShortVideo pipeline against a real encoded fixture.');

      const { workspace, project, candidateClipId } = await setupRenderableProject({ planId: 'creator' });
      workspaceIds.push(workspace.id);

      const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });

      const startedAt = Date.now();
      await renderShortVideo(
        fakeJob(renderJobRow.idempotencyKey, {
          renderJobId: renderJobRow.id,
          artifactId: enqueueResult.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: renderJobRow.sourceBriefVersionId,
          sourceMediaId: renderJobRow.sourceMediaId,
        })
      );
      const wallClockMs = Date.now() - startedAt;

      const artifact = await db.contentArtifact.findUniqueOrThrow({
        where: { id: enqueueResult.artifactId },
        include: { currentVersion: true },
      });
      expect(artifact.status).toBe('ready');
      expect(artifact.type).toBe('short_video');

      const body = artifact.currentVersion!.body as unknown as ShortVideoArtifactBody;
      expect(body.kind).toBe('short_video');
      expect(body.hasCaptions).toBe(true);
      expect(body.output.width).toBe(RENDER_CONFIG.width);
      expect(body.output.height).toBe(RENDER_CONFIG.height);
      expect(body.output.videoCodec).toBe('h264');
      expect(body.output.hasAudio).toBe(true);
      expect(body.output.durationMs).toBeGreaterThan(4000); // clip is ~6s
      expect(body.output.durationMs).toBeLessThan(8000);
      expect(body.output.fileSizeBytes).toBeGreaterThan(0);
      expect(body.performance.renderDurationMs).toBeGreaterThan(0);
      expect(body.performance.processingRatio).toBeGreaterThan(0);
      console.log(
        `[perf] source=${body.performance.sourceDurationMs}ms render=${body.performance.renderDurationMs}ms ` +
          `ratio=${body.performance.processingRatio.toFixed(2)} size=${(body.output.fileSizeBytes / 1024).toFixed(0)}KB wallClock=${wallClockMs}ms`
      );

      // The rendered MediaFile actually exists in storage and is a real, ffprobe-inspectable MP4.
      const mediaFile = await db.mediaFile.findUniqueOrThrow({ where: { id: body.mediaFileId } });
      expect(mediaFile.kind).toBe('rendered');
      const outputPath = storage.resolve(mediaFile.storageKey);
      const fileStat = await stat(outputPath);
      expect(fileStat.size).toBeGreaterThan(0);
      const outputProbe = await probeMedia(outputPath, 30_000);
      expect(outputProbe.width).toBe(1080);
      expect(outputProbe.height).toBe(1920);
      expect(outputProbe.hasAudio).toBe(true);

      // Source-grounded: every evidence id is a real transcript segment.
      const realSegmentIds = new Set(
        (await db.transcriptSegment.findMany({ where: { transcript: { projectId: project.id } } })).map((s) => s.id)
      );
      expect(body.evidence.length).toBeGreaterThan(0);
      for (const id of body.evidence) {
        expect(realSegmentIds.has(id)).toBe(true);
      }

      // Entitlement charged using the ACTUAL rendered duration, not just the nominal estimate.
      const usage = await db.usageEvent.findMany({ where: { workspaceId: workspace.id, eventType: 'render_minutes' } });
      expect(usage.length).toBe(1);
      expect(usage[0].quantity).toBeCloseTo(body.output.durationMs / 60_000, 5);

      const renderJobAfter = await db.renderJob.findUniqueOrThrow({ where: { id: renderJobRow.id } });
      expect(renderJobAfter.status).toBe('succeeded');
      expect(renderJobAfter.outputMediaId).toBe(mediaFile.id);
    }, 60_000);

    it('REAL FFMPEG VERIFIED: renders an Arabic clip without crashing, using the Arabic caption style, still fully grounded', async () => {
      if (!(await hasRealFfmpeg())) {
        console.warn('FFMPEG MOCKED (ffmpeg unavailable) — skipping real Arabic-render test.');
        return;
      }
      console.log('REAL FFMPEG VERIFIED — Arabic caption burn-in against a real encoded fixture.');

      const { workspace, project, candidateClipId } = await setupRenderableProject({ language: 'ar', planId: 'creator' });
      workspaceIds.push(workspace.id);

      const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });

      await renderShortVideo(
        fakeJob(renderJobRow.idempotencyKey, {
          renderJobId: renderJobRow.id,
          artifactId: enqueueResult.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: renderJobRow.sourceBriefVersionId,
          sourceMediaId: renderJobRow.sourceMediaId,
        })
      );

      const artifact = await db.contentArtifact.findUniqueOrThrow({
        where: { id: enqueueResult.artifactId },
        include: { currentVersion: true },
      });
      expect(artifact.status).toBe('ready');
      const body = artifact.currentVersion!.body as unknown as ShortVideoArtifactBody;
      expect(body.language).toBe('ar');
      expect(body.hasCaptions).toBe(true);

      const mediaFile = await db.mediaFile.findUniqueOrThrow({ where: { id: body.mediaFileId } });
      const outputPath = storage.resolve(mediaFile.storageKey);
      const fileStat = await stat(outputPath);
      expect(fileStat.size).toBeGreaterThan(0);
      const outputProbe = await probeMedia(outputPath, 30_000);
      expect(outputProbe.width).toBe(1080);
      expect(outputProbe.height).toBe(1920);
    }, 60_000);

    it('REAL FFMPEG VERIFIED: clamps gracefully when the candidate clip runs past the actual source duration', async () => {
      if (!(await hasRealFfmpeg())) {
        console.warn('FFMPEG MOCKED (ffmpeg unavailable) — skipping clamp test.');
        return;
      }

      // A source only 7s long, but the candidate clip (from a 12s
      // transcript) nominally runs to 9000ms — past the real duration.
      const { workspace, project, candidateClipId, mediaFile, brief } = await setupRenderableProject({
        videoDurationSeconds: 7,
      });
      workspaceIds.push(workspace.id);
      const clip = brief.candidateClips.find((c) => c.id === candidateClipId)!;
      expect(clip.endMs).toBeGreaterThan(mediaFile.durationMs ?? 0);

      const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });

      await renderShortVideo(
        fakeJob(renderJobRow.idempotencyKey, {
          renderJobId: renderJobRow.id,
          artifactId: enqueueResult.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: renderJobRow.sourceBriefVersionId,
          sourceMediaId: renderJobRow.sourceMediaId,
        })
      );

      const artifact = await db.contentArtifact.findUniqueOrThrow({
        where: { id: enqueueResult.artifactId },
        include: { currentVersion: true },
      });
      expect(artifact.status).toBe('ready'); // succeeded despite the out-of-range end, via clamping
      const body = artifact.currentVersion!.body as unknown as ShortVideoArtifactBody;
      expect(body.performance.sourceDurationMs).toBeLessThan(clip.endMs - clip.startMs);
    }, 60_000);

    it('REAL FFMPEG VERIFIED: flags sourceUpscaled when the source resolution is smaller than the 1080x1920 target', async () => {
      if (!(await hasRealFfmpeg())) {
        console.warn('FFMPEG MOCKED (ffmpeg unavailable) — skipping upscale test.');
        return;
      }

      const { workspace, project, candidateClipId } = await setupRenderableProject({
        videoWidth: 320,
        videoHeight: 240,
        videoDurationSeconds: 14,
      });
      workspaceIds.push(workspace.id);

      const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });

      await renderShortVideo(
        fakeJob(renderJobRow.idempotencyKey, {
          renderJobId: renderJobRow.id,
          artifactId: enqueueResult.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: renderJobRow.sourceBriefVersionId,
          sourceMediaId: renderJobRow.sourceMediaId,
        })
      );

      const artifact = await db.contentArtifact.findUniqueOrThrow({
        where: { id: enqueueResult.artifactId },
        include: { currentVersion: true },
      });
      const body = artifact.currentVersion!.body as unknown as ShortVideoArtifactBody;
      expect(body.sourceUpscaled).toBe(true);
      // Still full 1080x1920 output despite upscaling — no silently degraded target resolution.
      expect(body.output.width).toBe(1080);
      expect(body.output.height).toBe(1920);
    }, 60_000);

    it('REAL FFMPEG VERIFIED: renders a source with no audio stream without failing', async () => {
      if (!(await hasRealFfmpeg())) {
        console.warn('FFMPEG MOCKED (ffmpeg unavailable) — skipping no-audio test.');
        return;
      }

      const { workspace, project, candidateClipId } = await setupRenderableProject({ withAudio: false });
      workspaceIds.push(workspace.id);

      const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });

      await renderShortVideo(
        fakeJob(renderJobRow.idempotencyKey, {
          renderJobId: renderJobRow.id,
          artifactId: enqueueResult.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: renderJobRow.sourceBriefVersionId,
          sourceMediaId: renderJobRow.sourceMediaId,
        })
      );

      const artifact = await db.contentArtifact.findUniqueOrThrow({
        where: { id: enqueueResult.artifactId },
        include: { currentVersion: true },
      });
      expect(artifact.status).toBe('ready');
      const body = artifact.currentVersion!.body as unknown as ShortVideoArtifactBody;
      expect(body.output.hasAudio).toBe(false);
    }, 60_000);

    it('creates a new ArtifactVersion (never overwrites) when rendered again after a brief regeneration', async () => {
      if (!(await hasRealFfmpeg())) {
        console.warn('FFMPEG MOCKED (ffmpeg unavailable) — skipping versioning test.');
        return;
      }

      const { workspace, project, candidateClipId } = await setupRenderableProject();
      workspaceIds.push(workspace.id);

      const first = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const firstJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: first.renderJobId } });
      await renderShortVideo(
        fakeJob(firstJobRow.idempotencyKey, {
          renderJobId: firstJobRow.id,
          artifactId: first.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: firstJobRow.sourceBriefVersionId,
          sourceMediaId: firstJobRow.sourceMediaId,
        })
      );
      const artifactAfterFirst = await db.contentArtifact.findUniqueOrThrow({ where: { id: first.artifactId } });
      const firstVersionId = artifactAfterFirst.currentVersionId;

      // Regenerate the Editorial Brief (a new version, same clip id) and render again.
      await extractInsights(
        { data: { projectId: project.id, audience: 'v2' } } as Parameters<typeof extractInsights>[0],
        mockInsightProvider
      );
      const second = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      expect(second.jobId).not.toBe(first.jobId); // new brief version -> new idempotency key
      expect(second.artifactId).toBe(first.artifactId); // same short_video artifact identity (same candidateClipId)

      const secondJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: second.renderJobId } });
      await renderShortVideo(
        fakeJob(secondJobRow.idempotencyKey, {
          renderJobId: secondJobRow.id,
          artifactId: second.artifactId,
          projectId: project.id,
          candidateClipId,
          sourceBriefVersionId: secondJobRow.sourceBriefVersionId,
          sourceMediaId: secondJobRow.sourceMediaId,
        })
      );

      const artifactAfterSecond = await db.contentArtifact.findUniqueOrThrow({ where: { id: first.artifactId } });
      expect(artifactAfterSecond.currentVersionId).not.toBe(firstVersionId);
      const allVersions = await db.artifactVersion.findMany({ where: { artifactId: first.artifactId } });
      expect(allVersions.length).toBe(2);
      const oldVersionStillExists = await db.artifactVersion.findUnique({ where: { id: firstVersionId! } });
      expect(oldVersionStillExists).not.toBeNull();
    }, 60_000);

    it('fails honestly (dead_letter with a clear error) rather than hanging when ffmpeg is missing from PATH', async () => {
      const { workspace, project, candidateClipId } = await setupRenderableProject();
      workspaceIds.push(workspace.id);

      const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId });
      const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });

      const originalPath = process.env.PATH;
      process.env.PATH = '/nonexistent-path-for-testing';
      try {
        await expect(
          renderShortVideo(
            fakeJob(
              renderJobRow.idempotencyKey,
              {
                renderJobId: renderJobRow.id,
                artifactId: enqueueResult.artifactId,
                projectId: project.id,
                candidateClipId,
                sourceBriefVersionId: renderJobRow.sourceBriefVersionId,
                sourceMediaId: renderJobRow.sourceMediaId,
              },
              4 // last attempt (attempts: 5 means attemptsMade 4 is the 5th/final try)
            )
          )
        ).rejects.toThrow(/ffprobe|ffmpeg/i);
      } finally {
        process.env.PATH = originalPath;
      }

      const renderJobAfter = await db.renderJob.findUniqueOrThrow({ where: { id: renderJobRow.id } });
      expect(renderJobAfter.status).toBe('dead_letter');
      expect(renderJobAfter.error).toMatch(/ffprobe|ffmpeg/i);

      const artifactAfter = await db.contentArtifact.findUniqueOrThrow({ where: { id: enqueueResult.artifactId } });
      expect(artifactAfter.status).toBe('failed');
    }, 20_000);
  });
});
