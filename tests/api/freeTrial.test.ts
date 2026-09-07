import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../lib/db';
import { pipelineQueue } from '../../lib/queue';
import { mockContentProvider } from '../../lib/generation/mockProvider';
import { generateContent } from '../../lib/pipeline/generateContent';
import { POST as createProjectRoute } from '../../app/api/v1/projects/route';
import { POST as generateContentRoute } from '../../app/api/v1/projects/[id]/content/route';
import { POST as regenerateRoute } from '../../app/api/v1/artifacts/[id]/regenerate/route';
import { POST as exportRoute, GET as listExportsRoute } from '../../app/api/v1/projects/[id]/export/route';
import { cleanupWorkspace, createTestProjectWithBrief } from '../testUtils';

/**
 * Free-trial entitlement shape (P1 fix, quality-gate section B), tested
 * through the actual API route handlers — not just the underlying
 * lib/entitlements functions — since the requirement is explicitly
 * "enforce restrictions server-side, including direct API requests."
 * Every bypass attempt the quality gate called out (regeneration,
 * alternate endpoints, repeated requests, changing platform, repeated
 * exports) has a corresponding test below.
 */

function jsonRequest(url: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function membershipHeaders(workspaceId: string): Promise<Record<string, string>> {
  const userId = `test-user-${randomUUID()}`;
  await db.membership.create({ data: { workspaceId, userId, role: 'owner', status: 'active' } });
  return { 'x-workspace-id': workspaceId, 'x-user-id': userId };
}

describe('Free-trial entitlement enforcement via the actual API routes', () => {
  const workspaceIds: string[] = [];

  afterAll(async () => {
    await Promise.all(workspaceIds.map((id) => cleanupWorkspace(id)));
    await pipelineQueue.close();
    await db.$disconnect();
  });

  async function setupFreeProjectWithBrief() {
    const { workspace, project, briefArtifact } = await createTestProjectWithBrief('en');
    workspaceIds.push(workspace.id);
    const headers = await membershipHeaders(workspace.id);
    return { workspace, project, briefArtifact, headers };
  }

  it('"one limited source/project": a second project is rejected with 402, even via the real POST /projects route', async () => {
    const { workspace, headers } = await setupFreeProjectWithBrief();

    const mediaFile = await db.mediaFile.create({
      data: {
        workspaceId: workspace.id,
        kind: 'source',
        storageKey: `test/${randomUUID()}`,
        mimeType: 'video/mp4',
        status: 'uploaded',
        checksum: randomUUID(),
      },
    });

    const res = await createProjectRoute(
      jsonRequest('http://localhost/api/v1/projects', { title: 'Second project', sourceMediaId: mediaFile.id }, headers)
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/plan allows 1 project/);

    const projectCount = await db.project.count({ where: { workspaceId: workspace.id } });
    expect(projectCount).toBe(1); // the rejected request created nothing
  });

  it('generated content is persisted as a truncated preview (fewer sections, no CTA) with a recomputed, still-grounded groundingMap', async () => {
    const { project, briefArtifact } = await setupFreeProjectWithBrief();

    await generateContent(
      { data: { projectId: project.id, artifactType: 'blog_draft', platform: null, language: 'en', tone: 'informative', audience: 'founders' } } as Parameters<
        typeof generateContent
      >[0],
      { primary: mockContentProvider, fallback: null }
    );

    const artifact = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect(artifact.currentVersion!.tier).toBe('preview');

    const body = artifact.currentVersion!.body as {
      data: { sections: unknown[]; callToAction: unknown; conclusion: string };
      groundingMap: Record<string, unknown>;
    };
    expect(body.data.sections.length).toBe(1); // full draft has multiple sections; preview keeps one
    expect(body.data.callToAction).toBeNull(); // paid-only feature, stripped from the preview
    expect(Object.keys(body.groundingMap).length).toBeGreaterThan(0); // still a genuinely grounded preview

    void briefArtifact;
  });

  it('a paid (creator) plan gets the full, untruncated output with tier "paid"', async () => {
    const { workspace, project } = await setupFreeProjectWithBrief();
    await db.workspace.update({ where: { id: workspace.id }, data: { planId: 'creator' } });

    await generateContent(
      { data: { projectId: project.id, artifactType: 'blog_draft', platform: null, language: 'en', tone: 'informative', audience: 'founders' } } as Parameters<
        typeof generateContent
      >[0],
      { primary: mockContentProvider, fallback: null }
    );

    const artifact = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'blog_draft' },
      include: { currentVersion: true },
    });
    expect(artifact.currentVersion!.tier).toBe('paid');
    const rawData = await mockContentProvider.generate({
      artifactType: 'blog_draft',
      brief: { thesis: { text: '', evidence: [] }, audience: '', language: 'en', themes: [], keyPoints: [], quotes: [], hooks: [], candidateClips: [], claims: [], callToAction: null, evidenceMap: {}, confidenceNotes: '' },
      insights: await db.insight.findMany({ where: { projectId: project.id } }).then((rows) =>
        rows.map((r) => ({ id: r.id, type: r.type, text: r.text, segmentIds: r.segmentIds, startMs: r.startMs, endMs: r.endMs }))
      ),
      settings: { tone: 'informative', audience: 'founders', language: 'en', platform: null },
    });
    const fullSectionCount = (rawData as { sections: unknown[] }).sections.length;
    const body = artifact.currentVersion!.body as { data: { sections: unknown[] } };
    expect(body.data.sections.length).toBe(fullSectionCount); // nothing dropped for a paid plan
  });

  it('"one social platform only": requesting a second, different platform is rejected — even though the first platform can be regenerated freely', async () => {
    const { project, headers } = await setupFreeProjectWithBrief();

    // Simulate the worker completing the first (allowed) platform.
    await generateContent(
      { data: { projectId: project.id, artifactType: 'social_post', platform: 'x', language: 'en', tone: 'punchy', audience: 'founders' } } as Parameters<
        typeof generateContent
      >[0],
      { primary: mockContentProvider, fallback: null }
    );

    // Bypass attempt: "changing platform" through the plain generate endpoint.
    const switchRes = await generateContentRoute(
      jsonRequest(
        'http://localhost/api/v1/projects/x/content',
        { artifactType: 'social_post', platform: 'linkedin', language: 'en' },
        headers
      ),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(switchRes.status).toBe(402);
    const switchBody = await switchRes.json();
    expect(switchBody.error).toMatch(/1 social platform/);

    // Regenerating the ALREADY-used platform is not a new platform, so it's allowed.
    const sameplatformRes = await generateContentRoute(
      jsonRequest(
        'http://localhost/api/v1/projects/x/content',
        { artifactType: 'social_post', platform: 'x', language: 'en' },
        headers
      ),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(sameplatformRes.status).toBe(202);

    // Bypass attempt: "alternate endpoint" — regenerate the existing X
    // artifact. Structurally this can only ever regenerate the artifact's
    // own platform (it never lets the caller pick a different one), so it
    // cannot be used to acquire a second platform.
    const xArtifact = await db.contentArtifact.findFirstOrThrow({
      where: { projectId: project.id, type: 'social_post', platform: 'x' },
    });
    const regenRes = await regenerateRoute(
      jsonRequest('http://localhost/api/v1/artifacts/x/regenerate', {}, headers),
      { params: Promise.resolve({ id: xArtifact.id }) }
    );
    expect(regenRes.status).toBe(202);

    // Bypass attempt: "repeated API requests" for the same platform must
    // not multiply generation_call usage — enqueue is idempotent.
    const usageCountBefore = await db.usageEvent.count({ where: { workspaceId: project.workspaceId, eventType: 'generation_call' } });
    await generateContentRoute(
      jsonRequest('http://localhost/api/v1/projects/x/content', { artifactType: 'social_post', platform: 'x', language: 'en' }, headers),
      { params: Promise.resolve({ id: project.id }) }
    );
    const usageCountAfter = await db.usageEvent.count({ where: { workspaceId: project.workspaceId, eventType: 'generation_call' } });
    expect(usageCountAfter).toBe(usageCountBefore); // identical repeat request, no new usage row

    // Still only one platform has ever been used.
    const distinctPlatforms = await db.contentArtifact.findMany({
      where: { projectId: project.id, platform: { not: null } },
      select: { platform: true },
      distinct: ['platform'],
    });
    expect(distinctPlatforms.length).toBe(1);
  });

  it('"one free export": the first export succeeds, and every subsequent attempt — including via a fresh identical request — is rejected', async () => {
    const { project, headers } = await setupFreeProjectWithBrief();
    await generateContent(
      { data: { projectId: project.id, artifactType: 'blog_draft', platform: null, language: 'en', tone: 'informative', audience: 'founders' } } as Parameters<
        typeof generateContent
      >[0],
      { primary: mockContentProvider, fallback: null }
    );

    const firstExport = await exportRoute(jsonRequest('http://localhost/api/v1/projects/x/export', {}, headers), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(firstExport.status).toBe(201);
    const firstBody = await firstExport.json();
    expect(firstBody.export.manifestKey).toBeTruthy();

    // Bypass attempt: "repeated exports".
    const secondExport = await exportRoute(jsonRequest('http://localhost/api/v1/projects/x/export', {}, headers), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(secondExport.status).toBe(402);
    const secondBody = await secondExport.json();
    expect(secondBody.error).toMatch(/1 export/);

    const listRes = await listExportsRoute(
      new Request('http://localhost/api/v1/projects/x/export', { headers }),
      { params: Promise.resolve({ id: project.id }) }
    );
    const listBody = await listRes.json();
    expect(listBody.exports.length).toBe(1);
  });
});
