import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '../../../../lib/db';
import { storage } from '../../../../lib/storage';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../lib/workspace';

// POST /api/v1/uploads — create a resumable upload session (section 6.1
// and the endpoint table in section 7). The client uploads directly to
// object storage using the returned short-lived URL; the API only
// records the "uploading" MediaFile row here.
const createUploadSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request);
    const body = createUploadSchema.parse(await request.json());

    const session = await storage.createUploadSession({
      workspaceId: context.workspaceId,
      suggestedName: body.fileName,
    });

    const mediaFile = await db.mediaFile.create({
      data: {
        workspaceId: context.workspaceId,
        kind: 'source',
        storageKey: session.storageKey,
        mimeType: body.mimeType,
        status: 'uploading',
      },
    });

    return NextResponse.json(
      {
        mediaFileId: mediaFile.id,
        uploadUrl: session.uploadUrl,
        method: session.method,
        expiresAt: session.expiresAt,
      },
      { status: 201 }
    );
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
