import { NextResponse } from 'next/server';
import { db } from '../../../../../../lib/db';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';

// GET /api/v1/projects/{id}/editorial-brief — retrieve the current
// (latest) Editorial Brief version for a project, plus its version
// history. Every evidence array inside `body` references real
// TranscriptSegment IDs, resolvable via `body.evidenceMap`.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const artifact = await db.contentArtifact.findFirst({
      where: { projectId, type: 'editorial_brief' },
      include: {
        currentVersion: true,
        versions: { orderBy: { createdAt: 'desc' }, select: { id: true, model: true, createdAt: true } },
      },
    });

    if (!artifact || !artifact.currentVersion) {
      return NextResponse.json({ error: 'No editorial brief has been generated for this project yet.' }, { status: 404 });
    }

    return NextResponse.json({
      artifactId: artifact.id,
      currentVersionId: artifact.currentVersion.id,
      brief: artifact.currentVersion.body,
      model: artifact.currentVersion.model,
      generatedAt: artifact.currentVersion.createdAt,
      versions: artifact.versions,
    });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
