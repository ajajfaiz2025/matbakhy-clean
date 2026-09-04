import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '../../../../lib/db';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../lib/workspace';

// POST /api/v1/projects — create a project from an uploaded or
// imported source (section 7). Transcription/analysis are started via
// their own endpoints once this project exists.
const createProjectSchema = z.object({
  title: z.string().min(1),
  sourceMediaId: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request);
    const body = createProjectSchema.parse(await request.json());

    const sourceMedia = await db.mediaFile.findUnique({ where: { id: body.sourceMediaId } });
    if (!sourceMedia || sourceMedia.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'sourceMediaId does not belong to this workspace' }, { status: 404 });
    }
    if (sourceMedia.status !== 'uploaded' && sourceMedia.status !== 'normalized') {
      return NextResponse.json(
        { error: `Source media is not ready yet (status: ${sourceMedia.status})` },
        { status: 409 }
      );
    }

    const project = await db.project.create({
      data: {
        workspaceId: context.workspaceId,
        title: body.title,
        sourceMediaId: sourceMedia.id,
        status: 'draft',
      },
    });

    return NextResponse.json({ project }, { status: 201 });
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

export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request);
    const projects = await db.project.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ projects });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
