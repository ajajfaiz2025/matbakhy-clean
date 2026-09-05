import { NextResponse } from 'next/server';
import { db } from '../../../../../../lib/db';
import { enqueuePipelineJob } from '../../../../../../lib/queue';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';
import { getTranscriptionProvider } from '../../../../../../lib/transcription';

// POST /api/v1/projects/{id}/transcription — start or retry
// transcription (section 7). The job key folds in the source
// checksum and provider name (section 6.2's fingerprint) so retrying
// after a normalization change or a provider switch creates a new
// job instead of silently reusing a stale one.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;

    const project = await db.project.findUnique({ where: { id: projectId }, include: { sourceMedia: true } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!project.sourceMedia || project.sourceMedia.status !== 'normalized') {
      return NextResponse.json(
        { error: `Source media is not normalized yet (status: ${project.sourceMedia?.status ?? 'missing'})` },
        { status: 409 }
      );
    }

    const provider = getTranscriptionProvider();
    // BullMQ job IDs can't contain ':', so the provider name (e.g.
    // "openai:whisper-1") is sanitized before folding it into the key.
    const fingerprint = `${project.sourceMedia.checksum}-${provider.name.replace(/:/g, '_')}`;

    const job = await enqueuePipelineJob({
      workspaceId: context.workspaceId,
      projectId,
      mediaFileId: project.sourceMedia.id,
      type: 'transcription',
      idempotencyKey: `transcribe-${projectId}-${fingerprint}`,
      data: { projectId, mediaFileId: project.sourceMedia.id },
    });

    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
