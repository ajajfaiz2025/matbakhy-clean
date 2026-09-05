import { NextResponse } from 'next/server';
import { db } from '../../../../../lib/db';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../lib/workspace';

// GET /api/v1/jobs/{id} — read job status and progress (section 7).
// Polling this is a fallback for now; a real deployment would also
// push these over SSE/WebSocket as the job progresses.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id } = await params;

    const job = await db.pipelineJob.findUnique({ where: { id } });
    if (!job || job.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
