import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../lib/db';
import { extractInsights } from '../../lib/pipeline/extractInsights';
import { mockInsightProvider } from '../../lib/insights/mockProvider';
import { enqueuePipelineJob, pipelineQueue } from '../../lib/queue';
import type { InsightExtractionProvider } from '../../lib/insights/types';
import { cleanupWorkspace, createTestProjectWithTranscript, createTestWorkspace } from '../testUtils';

type FakeJob = Parameters<typeof extractInsights>[0];

function fakeJob(projectId: string, audience = ''): FakeJob {
  return { data: { projectId, audience } } as FakeJob;
}

describe('extractInsights pipeline (real Postgres + Redis)', () => {
  const workspaceIds: string[] = [];

  afterAll(async () => {
    await Promise.all(workspaceIds.map((id) => cleanupWorkspace(id)));
    await pipelineQueue.close();
    await db.$disconnect();
  });

  async function setupProject(language = 'en') {
    const workspace = await createTestWorkspace();
    workspaceIds.push(workspace.id);
    const { project, transcript } = await createTestProjectWithTranscript({
      workspaceId: workspace.id,
      language,
      segments: [
        { text: 'Welcome, today we discuss growth.', startMs: 0, endMs: 4000 },
        { text: 'We grew by 300 percent last year.', startMs: 4000, endMs: 9000 },
        { text: 'Please subscribe to our channel.', startMs: 9000, endMs: 14000 },
      ],
    });
    return { workspace, project, transcript };
  }

  it('extracts valid insights and persists a versioned Editorial Brief traceable to real segments', async () => {
    const { project, transcript } = await setupProject();

    await extractInsights(fakeJob(project.id), mockInsightProvider);

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'editorial_brief' },
      include: { currentVersion: true },
    });
    expect(artifact).not.toBeNull();
    expect(artifact?.currentVersion).not.toBeNull();

    const brief = artifact!.currentVersion!.body as { evidenceMap: Record<string, unknown> };
    const realSegmentIds = new Set(transcript.segments.map((segment) => segment.id));
    for (const id of Object.keys(brief.evidenceMap)) {
      expect(realSegmentIds.has(id)).toBe(true);
    }

    const insights = await db.insight.findMany({ where: { projectId: project.id } });
    expect(insights.length).toBeGreaterThan(0);
    for (const insight of insights) {
      for (const segmentId of insight.segmentIds) {
        expect(realSegmentIds.has(segmentId)).toBe(true);
      }
    }

    const updatedProject = await db.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(updatedProject.status).toBe('ready');
  });

  it('rejects output with an invalid segment reference and persists nothing, even after a failed repair', async () => {
    const { project } = await setupProject();

    const alwaysBroken: InsightExtractionProvider = {
      name: 'always-broken-test-provider',
      async extract() {
        return {
          thesis: { text: 'x', evidence: ['does-not-exist'] },
          audience: '',
          language: 'en',
          themes: [],
          keyPoints: [],
          quotes: [],
          hooks: [],
          candidateClips: [],
          claims: [],
          callToAction: null,
          confidenceNotes: 'broken',
        };
      },
      // No repair() — the orchestrator falls back to calling extract()
      // again, which returns the same broken output, so this must
      // ultimately fail rather than loop forever or silently accept it.
    };

    await expect(extractInsights(fakeJob(project.id), alwaysBroken)).rejects.toThrow(/grounding/);

    const artifact = await db.contentArtifact.findFirst({ where: { projectId: project.id, type: 'editorial_brief' } });
    expect(artifact).toBeNull();
    const insights = await db.insight.findMany({ where: { projectId: project.id } });
    expect(insights.length).toBe(0);
  });

  it('recovers via the one-shot repair path when the first attempt is invalid but repair() fixes it', async () => {
    const { project, transcript } = await setupProject();
    const validSegmentId = transcript.segments[0].id;
    let calls = 0;

    const flakyProvider: InsightExtractionProvider = {
      name: 'flaky-test-provider',
      async extract() {
        calls += 1;
        return {
          thesis: { text: 'bad', evidence: ['nonexistent-segment'] },
          audience: '',
          language: 'en',
          themes: [],
          keyPoints: [],
          quotes: [],
          hooks: [],
          candidateClips: [],
          claims: [],
          callToAction: null,
          confidenceNotes: 'first attempt, intentionally broken',
        };
      },
      async repair() {
        calls += 1;
        return {
          thesis: { text: 'fixed', evidence: [validSegmentId] },
          audience: '',
          language: 'en',
          themes: [],
          keyPoints: [],
          quotes: [],
          hooks: [],
          candidateClips: [],
          claims: [],
          callToAction: null,
          confidenceNotes: 'repaired',
        };
      },
    };

    await extractInsights(fakeJob(project.id), flakyProvider);
    expect(calls).toBe(2); // one extract() + one repair(), not an unbounded loop

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'editorial_brief' },
      include: { currentVersion: true },
    });
    expect((artifact?.currentVersion?.body as { thesis: { text: string } }).thesis.text).toBe('fixed');
  });

  it('creates a new version on re-run without overwriting the previous one, and repoints currentVersionId', async () => {
    const { project } = await setupProject();

    await extractInsights(fakeJob(project.id, 'audience-a'), mockInsightProvider);
    const artifactAfterFirst = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'editorial_brief' },
    });
    const firstVersionId = artifactAfterFirst.currentVersionId;
    expect(firstVersionId).not.toBeNull();

    await extractInsights(fakeJob(project.id, 'audience-b'), mockInsightProvider);
    const artifactAfterSecond = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'editorial_brief' },
    });

    expect(artifactAfterSecond.currentVersionId).not.toBe(firstVersionId);

    const allVersions = await db.artifactVersion.findMany({ where: { artifactId: artifactAfterSecond.id } });
    expect(allVersions.length).toBe(2);

    const firstVersionStillExists = await db.artifactVersion.findUnique({ where: { id: firstVersionId! } });
    expect(firstVersionStillExists).not.toBeNull(); // old version preserved, not overwritten
  });

  it('is idempotent at the queue level: enqueuing the same analysis job twice reuses one PipelineJob row', async () => {
    const { workspace, project } = await setupProject();
    const idempotencyKey = `analyze-test-${randomUUID()}`;

    const jobA = await enqueuePipelineJob({
      workspaceId: workspace.id,
      projectId: project.id,
      type: 'analysis',
      idempotencyKey,
      data: { projectId: project.id, audience: '' },
    });
    const jobB = await enqueuePipelineJob({
      workspaceId: workspace.id,
      projectId: project.id,
      type: 'analysis',
      idempotencyKey,
      data: { projectId: project.id, audience: '' },
    });

    expect(jobB.id).toBe(jobA.id);

    const rows = await db.pipelineJob.findMany({ where: { idempotencyKey } });
    expect(rows.length).toBe(1);

    // No worker is running in this test process, so nothing will ever
    // consume this BullMQ job — remove it so it doesn't sit in Redis
    // (and get picked up by a real worker for a since-deleted project).
    const bullJob = await pipelineQueue.getJob(idempotencyKey);
    await bullJob?.remove();
  });
});
