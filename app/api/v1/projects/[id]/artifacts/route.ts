import { NextResponse } from 'next/server';
import { db } from '../../../../../../lib/db';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';

// GET /api/v1/projects/{id}/artifacts — list generated content
// artifacts for a project (blog drafts, social posts, captions).
// Excludes the editorial_brief artifact itself, which has its own
// endpoint (GET /api/v1/projects/{id}/editorial-brief).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const artifacts = await db.contentArtifact.findMany({
      where: { projectId, type: { not: 'editorial_brief' } },
      include: { currentVersion: true },
      orderBy: { id: 'asc' },
    });

    return NextResponse.json({
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        type: artifact.type,
        platform: artifact.platform,
        language: artifact.language,
        status: artifact.status,
        currentVersionId: artifact.currentVersionId,
        title:
          artifact.currentVersion && typeof artifact.currentVersion.body === 'object'
            ? (() => {
                const body = artifact.currentVersion!.body as { data?: { title?: string }; title?: string };
                return body.data?.title ?? body.title ?? null;
              })()
            : null,
        updatedAt: artifact.currentVersion?.createdAt ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
