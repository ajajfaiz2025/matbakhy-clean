import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '../../../../../../lib/db';
import { assertExportLimit, EntitlementError } from '../../../../../../lib/entitlements';
import { storage } from '../../../../../../lib/storage';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';

interface ExportManifestArtifact {
  type: string;
  platform: string | null;
  language: string;
  tier: string;
  createdAt: string;
  body: unknown;
}

/**
 * POST /api/v1/projects/{id}/export — bundle every ready content
 * artifact for a project into a downloadable manifest. Gated by
 * assertExportLimit (P1 fix, quality-gate section B: "one free
 * export"), enforced here regardless of caller — there is no
 * client-side-only gate, and re-requesting this endpoint after the
 * first export always fails for a free workspace. What the manifest
 * *contains* is already governed upstream by generateContent's preview
 * restriction (free-plan artifacts are already preview-tier when
 * persisted) — export does not apply any restriction of its own.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    await assertExportLimit(context.workspaceId);

    const artifacts = await db.contentArtifact.findMany({
      where: { projectId, status: 'ready', type: { not: 'editorial_brief' } },
      include: { currentVersion: true },
    });

    const manifest = {
      projectId,
      workspaceId: context.workspaceId,
      exportedAt: new Date().toISOString(),
      artifacts: artifacts
        .filter((artifact) => artifact.currentVersion)
        .map(
          (artifact): ExportManifestArtifact => ({
            type: artifact.type,
            platform: artifact.platform,
            language: artifact.language,
            tier: artifact.currentVersion!.tier,
            createdAt: artifact.currentVersion!.createdAt.toISOString(),
            body: artifact.currentVersion!.body,
          })
        ),
    };

    const manifestKey = `${context.workspaceId}/exports/${randomUUID()}.json`;
    await storage.writeText(manifestKey, JSON.stringify(manifest, null, 2));

    const exportRow = await db.export.create({
      data: { workspaceId: context.workspaceId, projectId, status: 'ready', manifestKey },
    });

    const downloadUrl = await storage.getSignedDownloadUrl(manifestKey);

    return NextResponse.json({ export: exportRow, downloadUrl }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EntitlementError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

// GET /api/v1/projects/{id}/export — list this workspace's exports for
// the project, so a client (or a test) can confirm the standing count
// without triggering another export.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const exports = await db.export.findMany({
      where: { workspaceId: context.workspaceId, projectId },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ exports });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
