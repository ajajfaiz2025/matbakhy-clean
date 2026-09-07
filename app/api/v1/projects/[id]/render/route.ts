import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '../../../../../../lib/db';
import { EntitlementError } from '../../../../../../lib/entitlements';
import {
  CandidateClipNotFoundError,
  InvalidClipRangeError,
  NoEditorialBriefError,
  SourceMediaNotReadyError,
  enqueueRenderJob,
} from '../../../../../../lib/rendering/enqueue';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';
import { startRenderRequestSchema } from '../../../../../../src/domain/schemas';

// POST /api/v1/projects/{id}/render — Step 8: render one candidateClip
// from the project's CURRENT Editorial Brief into a 9:16 short video.
// Async and idempotent like every other pipeline stage — reuses GET
// /api/v1/jobs/{id} for status and GET /api/v1/projects/{id}/artifacts
// / GET /api/v1/artifacts/{id} to read the resulting short_video
// artifact, rather than adding parallel endpoints for either.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;
    const body = startRenderRequestSchema.parse(await request.json());

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const result = await enqueueRenderJob({
      workspaceId: context.workspaceId,
      projectId,
      candidateClipId: body.candidateClipId,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (
      error instanceof EntitlementError ||
      error instanceof NoEditorialBriefError ||
      error instanceof CandidateClipNotFoundError ||
      error instanceof SourceMediaNotReadyError ||
      error instanceof InvalidClipRangeError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body', issues: error.issues }, { status: 400 });
    }
    throw error;
  }
}
