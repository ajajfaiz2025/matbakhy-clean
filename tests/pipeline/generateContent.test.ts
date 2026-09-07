import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../lib/db';
import { fetchWithTimeout } from '../../lib/providers/fetchWithTimeout';
import { generateContent } from '../../lib/pipeline/generateContent';
import { mockContentProvider } from '../../lib/generation/mockProvider';
import { enqueueGenerationJob } from '../../lib/generation/enqueue';
import { pipelineQueue } from '../../lib/queue';
import type { ContentGenerationProvider } from '../../lib/generation/types';
import { cleanupWorkspace, createTestProjectWithBrief } from '../testUtils';

type FakeJob = Parameters<typeof generateContent>[0];

function fakeJob(
  projectId: string,
  overrides: Partial<{
    artifactType: 'blog_draft' | 'social_post' | 'caption';
    platform: 'x' | 'linkedin' | 'instagram' | null;
    language: 'en' | 'ar';
    tone: string;
    audience: string;
    dialect?: string;
  }> = {}
): FakeJob {
  return {
    data: {
      projectId,
      artifactType: 'blog_draft',
      platform: null,
      language: 'en',
      tone: 'informative',
      audience: 'founders',
      ...overrides,
    },
  } as FakeJob;
}

describe('generateContent pipeline (real Postgres + Redis)', () => {
  const workspaceIds: string[] = [];

  afterAll(async () => {
    await Promise.all(workspaceIds.map((id) => cleanupWorkspace(id)));
    await pipelineQueue.close();
    await db.$disconnect();
  });

  async function setupProject(language: 'en' | 'ar' = 'en') {
    const { workspace, project, insights, briefArtifact } = await createTestProjectWithBrief(language);
    workspaceIds.push(workspace.id);
    return { workspace, project, insights, briefArtifact };
  }

  it('generates a valid, grounded blog draft and persists it as a versioned ContentArtifact', async () => {
    const { project, briefArtifact } = await setupProject();

    await generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), { primary: mockContentProvider, fallback: null });

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect(artifact).not.toBeNull();
    expect(artifact?.status).toBe('ready');
    expect(artifact?.language).toBe('en');
    expect(artifact?.platform).toBeNull();

    const versionBody = artifact!.currentVersion!.body as {
      kind: string;
      data: { title: string; sections: unknown[] };
      groundingMap: Record<string, { segmentIds: string[] }>;
    };
    expect(versionBody.kind).toBe('blog_draft');
    expect(versionBody.data.sections.length).toBeGreaterThan(0);
    expect(artifact!.currentVersion!.sourceBriefVersionId).toBe(briefArtifact.currentVersionId);

    // Source grounding: every groundingMap entry must resolve to a real
    // transcript segment (via the insight it was built from).
    const realSegmentIds = new Set(
      (await db.transcriptSegment.findMany({ where: { transcript: { projectId: project.id } } })).map((s) => s.id)
    );
    for (const ref of Object.values(versionBody.groundingMap)) {
      for (const segId of ref.segmentIds) {
        expect(realSegmentIds.has(segId)).toBe(true);
      }
    }
  });

  it('generates a valid, grounded X post', async () => {
    const { project } = await setupProject();
    await generateContent(
      fakeJob(project.id, { artifactType: 'social_post', platform: 'x', tone: 'punchy' }),
      { primary: mockContentProvider, fallback: null }
    );
    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'social_post', platform: 'x' },
      include: { currentVersion: true },
    });
    expect(artifact?.status).toBe('ready');
    expect((artifact!.currentVersion!.body as { data: { body: string } }).data.body.length).toBeLessThanOrEqual(220);
  });

  it('generates a valid, grounded LinkedIn post', async () => {
    const { project } = await setupProject();
    await generateContent(
      fakeJob(project.id, { artifactType: 'social_post', platform: 'linkedin', tone: 'professional' }),
      { primary: mockContentProvider, fallback: null }
    );
    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'social_post', platform: 'linkedin' },
    });
    expect(artifact?.status).toBe('ready');
  });

  it('generates a valid, grounded Instagram caption', async () => {
    const { project } = await setupProject();
    await generateContent(
      fakeJob(project.id, { artifactType: 'caption', platform: 'instagram', tone: 'engaging' }),
      { primary: mockContentProvider, fallback: null }
    );
    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'caption', platform: 'instagram' },
      include: { currentVersion: true },
    });
    expect(artifact?.status).toBe('ready');
    expect((artifact!.currentVersion!.body as { data: { hashtags: string[] } }).data.hashtags.length).toBeGreaterThan(0);
  });

  it('generates a valid, grounded Arabic blog draft', async () => {
    const { project } = await setupProject('ar');
    await generateContent(
      fakeJob(project.id, { artifactType: 'blog_draft', language: 'ar', audience: '' }),
      { primary: mockContentProvider, fallback: null }
    );
    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect(artifact?.language).toBe('ar');
    const data = (artifact!.currentVersion!.body as { data: { title: string } }).data;
    expect(data.title).toMatch(/[؀-ۿ]/);
  });

  it('rejects output with an invalid insight reference and persists nothing, even after a failed repair', async () => {
    const { project } = await setupProject();

    const alwaysBroken: ContentGenerationProvider = {
      name: 'always-broken-test-provider',
      async generate() {
        return {
          title: 'x',
          introduction: 'x',
          sections: [{ heading: 'x', body: 'x', evidence: ['does-not-exist'] }],
          conclusion: 'x',
          callToAction: null,
          unsupportedClaims: [],
        };
      },
    };

    await expect(
      generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), { primary: alwaysBroken, fallback: null })
    ).rejects.toThrow(/grounding/);

    const artifact = await db.contentArtifact.findFirst({ where: { projectId: project.id, type: 'blog_draft' } });
    expect(artifact).toBeNull();
  });

  it('recovers via the one-shot repair path when the first attempt is invalid but repair() fixes it', async () => {
    const { project, insights } = await setupProject();
    const validInsightId = insights[0].id;
    let calls = 0;

    const flakyProvider: ContentGenerationProvider = {
      name: 'flaky-test-provider',
      async generate() {
        calls += 1;
        return {
          title: 'bad',
          introduction: 'bad',
          sections: [{ heading: 'bad', body: 'bad', evidence: ['nonexistent'] }],
          conclusion: 'bad',
          callToAction: null,
          unsupportedClaims: [],
        };
      },
      async repair() {
        calls += 1;
        return {
          title: 'fixed',
          introduction: 'fixed',
          sections: [{ heading: 'fixed', body: 'fixed', evidence: [validInsightId] }],
          conclusion: 'fixed',
          callToAction: null,
          unsupportedClaims: [],
        };
      },
    };

    await generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), { primary: flakyProvider, fallback: null });
    expect(calls).toBe(2);

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect((artifact!.currentVersion!.body as { data: { title: string } }).data.title).toBe('fixed');
  });

  it('falls back to the secondary provider when the primary provider fails outright', async () => {
    const { project } = await setupProject();

    const throwingProvider: ContentGenerationProvider = {
      name: 'unreachable-primary',
      async generate() {
        throw new Error('simulated network/auth failure');
      },
    };

    await generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), {
      primary: throwingProvider,
      fallback: mockContentProvider,
    });

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect(artifact?.status).toBe('ready');
    expect(artifact!.currentVersion!.model).toBe('mock'); // fallback provider's name, not the primary's
  });

  it('falls back to the secondary provider when the primary times out (real fetchWithTimeout, not a hand-thrown error)', async () => {
    const { project } = await setupProject();
    const originalFetch = global.fetch;

    const hangingProvider: ContentGenerationProvider = {
      name: 'hanging-primary',
      async generate() {
        // A real hung upstream request: the mocked fetch never resolves
        // on its own — only fetchWithTimeout's AbortController forces it.
        global.fetch = ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          })) as unknown as typeof fetch;
        await fetchWithTimeout('https://example.invalid/hang', {}, 50);
        throw new Error('unreachable — fetchWithTimeout should have thrown');
      },
    };

    try {
      await generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), {
        primary: hangingProvider,
        fallback: mockContentProvider,
      });
    } finally {
      global.fetch = originalFetch;
    }

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect(artifact?.status).toBe('ready');
    expect(artifact!.currentVersion!.model).toBe('mock'); // fell back after the real timeout fired
  });

  it('throws (rather than fabricating output) when the primary fails and there is no fallback', async () => {
    const { project } = await setupProject();
    const throwingProvider: ContentGenerationProvider = {
      name: 'unreachable-primary',
      async generate() {
        throw new Error('simulated network/auth failure');
      },
    };

    await expect(
      generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), { primary: throwingProvider, fallback: null })
    ).rejects.toThrow(/simulated network/);
  });

  it('creates a new version on regeneration without overwriting the previous one', async () => {
    const { project } = await setupProject();

    await generateContent(fakeJob(project.id, { artifactType: 'blog_draft', tone: 'informative' }), {
      primary: mockContentProvider,
      fallback: null,
    });
    const artifactAfterFirst = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'blog_draft' },
    });
    const firstVersionId = artifactAfterFirst.currentVersionId;

    await generateContent(fakeJob(project.id, { artifactType: 'blog_draft', tone: 'playful' }), {
      primary: mockContentProvider,
      fallback: null,
    });
    const artifactAfterSecond = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'blog_draft' },
    });

    expect(artifactAfterSecond.id).toBe(artifactAfterFirst.id); // same artifact identity
    expect(artifactAfterSecond.currentVersionId).not.toBe(firstVersionId);

    const allVersions = await db.artifactVersion.findMany({ where: { artifactId: artifactAfterSecond.id } });
    expect(allVersions.length).toBe(2);

    const firstVersionStillExists = await db.artifactVersion.findUnique({ where: { id: firstVersionId! } });
    expect(firstVersionStillExists).not.toBeNull(); // old version preserved, not overwritten
  });

  it('is idempotent end to end: enqueueGenerationJob with unchanged settings reuses one job; a changed tone creates a new one', async () => {
    const { workspace, project } = await setupProject();

    const first = await enqueueGenerationJob({
      workspaceId: workspace.id,
      projectId: project.id,
      artifactType: 'blog_draft',
      platform: null,
      language: 'en',
      tone: 'informative',
      audience: 'founders',
    });
    const second = await enqueueGenerationJob({
      workspaceId: workspace.id,
      projectId: project.id,
      artifactType: 'blog_draft',
      platform: null,
      language: 'en',
      tone: 'informative',
      audience: 'founders',
    });
    expect(second.jobId).toBe(first.jobId);

    const third = await enqueueGenerationJob({
      workspaceId: workspace.id,
      projectId: project.id,
      artifactType: 'blog_draft',
      platform: null,
      language: 'en',
      tone: 'playful', // changed setting
      audience: 'founders',
    });
    expect(third.jobId).not.toBe(first.jobId);

    const rows = await db.pipelineJob.findMany({ where: { projectId: project.id, type: 'generation' } });
    expect(rows.length).toBe(2);

    // enqueueGenerationJob's returned jobId is the PipelineJob DB row's
    // id (what GET /api/v1/jobs/{id} expects) — BullMQ itself indexes
    // jobs by idempotencyKey, so cleanup has to go through that field,
    // not the returned jobId directly.
    for (const row of rows) {
      const bullJob = await pipelineQueue.getJob(row.idempotencyKey);
      await bullJob?.remove();
    }
  });

  it('an explicit regenerate with byte-identical settings still produces a distinct job (does not silently collide with the original generate)', async () => {
    const { workspace, project } = await setupProject();

    // The plain "generate" request an artifact already exists from.
    const original = await enqueueGenerationJob({
      workspaceId: workspace.id,
      projectId: project.id,
      artifactType: 'blog_draft',
      platform: null,
      language: 'en',
      tone: 'informative',
      audience: 'founders',
    });

    // What POST /api/v1/artifacts/{id}/regenerate does: same settings,
    // but tagged with the artifact's current version so it can't reuse
    // the original request's idempotency key.
    const regenerated = await enqueueGenerationJob({
      workspaceId: workspace.id,
      projectId: project.id,
      artifactType: 'blog_draft',
      platform: null,
      language: 'en',
      tone: 'informative',
      audience: 'founders',
      regenerateFrom: 'some-version-id',
    });

    expect(regenerated.jobId).not.toBe(original.jobId);

    const rows = await db.pipelineJob.findMany({ where: { projectId: project.id, type: 'generation' } });
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const bullJob = await pipelineQueue.getJob(row.idempotencyKey);
      await bullJob?.remove();
    }
  });

  it('throws a clear error when no Editorial Brief exists yet', async () => {
    const workspace = await db.workspace.create({
      data: { id: `test-ws-${randomUUID()}`, name: 'No Brief Workspace', planId: 'free' },
    });
    workspaceIds.push(workspace.id);
    const mediaFile = await db.mediaFile.create({
      data: { workspaceId: workspace.id, kind: 'source', storageKey: `test/${randomUUID()}`, mimeType: 'video/mp4', status: 'normalized' },
    });
    const project = await db.project.create({
      data: { workspaceId: workspace.id, title: 'No Brief Project', sourceMediaId: mediaFile.id, status: 'draft' },
    });

    await expect(
      generateContent(fakeJob(project.id, { artifactType: 'blog_draft' }), { primary: mockContentProvider, fallback: null })
    ).rejects.toThrow(/Editorial Brief/);
  });
});
