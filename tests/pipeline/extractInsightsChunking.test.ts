import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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

function spyProvider(base: InsightExtractionProvider) {
  const calls = { extract: 0, repair: 0, reconcile: 0 };
  const spied: InsightExtractionProvider = {
    name: base.name,
    async extract(input) {
      calls.extract += 1;
      return base.extract(input);
    },
    repair: base.repair
      ? async (input, previousOutput, errors) => {
          calls.repair += 1;
          return base.repair!(input, previousOutput, errors);
        }
      : undefined,
    reconcile: base.reconcile
      ? async (input) => {
          calls.reconcile += 1;
          return base.reconcile!(input);
        }
      : undefined,
  };
  return { spied, calls };
}

function makeSegments(count: number, wordsPerSegment: number): Array<{ text: string; startMs: number; endMs: number }> {
  return Array.from({ length: count }, (_, i) => ({
    text: Array.from({ length: wordsPerSegment }, (_, w) => `word${i}_${w}`).join(' '),
    startMs: i * 3000,
    endMs: (i + 1) * 3000,
  }));
}

describe('extractInsights transcript chunking (real Postgres + Redis)', () => {
  const workspaceIds: string[] = [];
  const originalBudget = process.env.INSIGHT_CHUNK_TOKEN_BUDGET;

  afterAll(async () => {
    await Promise.all(workspaceIds.map((id) => cleanupWorkspace(id)));
    await pipelineQueue.close();
    await db.$disconnect();
  });

  afterEach(() => {
    if (originalBudget === undefined) delete process.env.INSIGHT_CHUNK_TOKEN_BUDGET;
    else process.env.INSIGHT_CHUNK_TOKEN_BUDGET = originalBudget;
  });

  async function setupProject(segments: ReturnType<typeof makeSegments>) {
    const workspace = await createTestWorkspace();
    workspaceIds.push(workspace.id);
    const { project, transcript } = await createTestProjectWithTranscript({
      workspaceId: workspace.id,
      language: 'en',
      segments,
    });
    return { workspace, project, transcript };
  }

  it('short transcript: exactly one extract() call, no reconcile() — unchanged from pre-chunking behavior', async () => {
    process.env.INSIGHT_CHUNK_TOKEN_BUDGET = '6000';
    const { project } = await setupProject(makeSegments(5, 8));
    const { spied, calls } = spyProvider(mockInsightProvider);

    await extractInsights(fakeJob(project.id), spied);

    expect(calls.extract).toBe(1);
    expect(calls.reconcile).toBe(0);
    const artifact = await db.contentArtifact.findFirst({ where: { projectId: project.id, type: 'editorial_brief' } });
    expect(artifact?.status).toBe('ready');
  });

  it('medium transcript, just under budget: still exactly one extract() call', async () => {
    process.env.INSIGHT_CHUNK_TOKEN_BUDGET = '200';
    const { project } = await setupProject(makeSegments(10, 6)); // ≈120-130 estimated tokens, under 200
    const { spied, calls } = spyProvider(mockInsightProvider);

    await extractInsights(fakeJob(project.id), spied);

    expect(calls.extract).toBe(1);
    expect(calls.reconcile).toBe(0);
  });

  it('synthetic long transcript (provider with reconcile()): chunks deterministically, runs multiple local extractions + one reconciliation, and the final brief stays fully grounded', async () => {
    process.env.INSIGHT_CHUNK_TOKEN_BUDGET = '80';
    const segments = makeSegments(30, 10); // well over an 80-token budget
    const { project, transcript } = await setupProject(segments);
    const { spied, calls } = spyProvider(mockInsightProvider);

    await extractInsights(fakeJob(project.id), spied);

    expect(calls.extract).toBeGreaterThan(1);
    expect(calls.reconcile).toBe(1);

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'editorial_brief' },
      include: { currentVersion: true },
    });
    expect(artifact?.status).toBe('ready');

    const brief = artifact!.currentVersion!.body as { evidenceMap: Record<string, { segmentIds: string[] }> };
    const realSegmentIds = new Set(transcript.segments.map((s) => s.id));
    expect(Object.keys(brief.evidenceMap).length).toBeGreaterThan(0);
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
  });

  it('synthetic long transcript with a provider that has NO reconcile(): falls back to the deterministic merge and still produces a fully grounded brief', async () => {
    process.env.INSIGHT_CHUNK_TOKEN_BUDGET = '80';
    const segments = makeSegments(20, 10);
    const { project, transcript } = await setupProject(segments);

    const providerWithoutReconcile: InsightExtractionProvider = {
      name: 'mock-no-reconcile',
      extract: mockInsightProvider.extract,
      // reconcile intentionally omitted
    };
    const { spied, calls } = spyProvider(providerWithoutReconcile);

    await extractInsights(fakeJob(project.id), spied);

    expect(calls.extract).toBeGreaterThan(1);
    expect(calls.reconcile).toBe(0); // provider has none — deterministic path used instead

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'editorial_brief' },
      include: { currentVersion: true },
    });
    expect(artifact?.status).toBe('ready');

    const brief = artifact!.currentVersion!.body as {
      evidenceMap: Record<string, { segmentIds: string[] }>;
      confidenceNotes: string;
    };
    expect(brief.confidenceNotes).toMatch(/deterministically/);
    const realSegmentIds = new Set(transcript.segments.map((s) => s.id));
    for (const id of Object.keys(brief.evidenceMap)) {
      expect(realSegmentIds.has(id)).toBe(true);
    }
  });

  it('remains idempotent at the queue level even for a long/chunked transcript', async () => {
    process.env.INSIGHT_CHUNK_TOKEN_BUDGET = '80';
    const { workspace, project } = await setupProject(makeSegments(30, 10));

    const idempotencyKey = `analyze-chunk-test-${randomUUID()}`;
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
    const bullJob = await pipelineQueue.getJob(idempotencyKey);
    await bullJob?.remove();
  });
});
