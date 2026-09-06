import { NextResponse } from 'next/server';
import { db } from '../../../../../../lib/db';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';

// GET /api/v1/artifacts/{id}/versions — full version history (every
// past body, not just the current one). All previous versions remain
// retrievable — regenerating or editing never deletes them.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id } = await params;

    const artifact = await db.contentArtifact.findUnique({
      where: { id },
      include: { project: { select: { workspaceId: true } } },
    });
    if (!artifact || artifact.project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }

    const versions = await db.artifactVersion.findMany({
      where: { artifactId: id },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      artifactId: id,
      currentVersionId: artifact.currentVersionId,
      versions,
    });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
