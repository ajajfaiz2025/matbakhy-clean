import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '../../../../../../lib/db';
import { getInsightProvider } from '../../../../../../lib/insights';
import { enqueuePipelineJob } from '../../../../../../lib/queue';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';

const requestSchema = z.object({ audience: z.string().max(200).optional() });

function sanitizeForJobId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

// POST /api/v1/projects/{id}/analysis — start or retry insight
// extraction (section 7). The job key folds in the provider, audience,
// and a lightweight transcript fingerprint (section 6.2) so retrying
// after a re-transcription or a config change (e.g. audience) produces
// a new job — and therefore a new Editorial Brief version — instead of
// silently reusing a stale one.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;

    const body = request.headers.get('content-length') !== '0' ? await request.json().catch(() => ({})) : {};
    const { audience = '' } = requestSchema.parse(body);

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const transcript = await db.transcript.findUnique({
      where: { projectId },
      include: { _count: { select: { segments: true } } },
    });
    if (!transcript || transcript._count.segments === 0) {
      return NextResponse.json({ error: 'Project has no transcript to analyze yet.' }, { status: 409 });
    }

    const provider = getInsightProvider();
    // Lightweight content fingerprint: segment count + total duration.
    // A re-transcription almost always changes one of these; a real
    // content checksum (like MediaFile.checksum) would be more precise
    // but transcripts don't carry one yet.
    const span = await db.transcriptSegment.aggregate({
      where: { transcriptId: transcript.id },
      _max: { endMs: true },
    });
    const fingerprint = `${transcript._count.segments}-${span._max.endMs ?? 0}`;
    const idempotencyKey = `analyze-${projectId}-${sanitizeForJobId(provider.name)}-${sanitizeForJobId(audience) || 'default'}-${fingerprint}`;

    const job = await enqueuePipelineJob({
      workspaceId: context.workspaceId,
      projectId,
      type: 'analysis',
      idempotencyKey,
      data: { projectId, audience },
    });

    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body', issues: error.issues }, { status: 400 });
    }
    throw error;
  }
}
