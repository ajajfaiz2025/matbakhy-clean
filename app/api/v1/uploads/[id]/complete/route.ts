import { NextResponse } from 'next/server';
import { db } from '../../../../../../lib/db';
import { storage } from '../../../../../../lib/storage';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';
import { recordUsage } from '../../../../../../lib/entitlements';
import { enqueuePipelineJob } from '../../../../../../lib/queue';

// POST /api/v1/uploads/{id}/complete — the API verifies the object
// through a storage head request rather than trusting the client
// (section 6.1), then enqueues the normalization worker (FFmpeg
// validation + metadata extraction) instead of doing that work inline.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id } = await params;

    const mediaFile = await db.mediaFile.findUnique({ where: { id } });
    if (!mediaFile || mediaFile.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Media file not found' }, { status: 404 });
    }

    const head = await storage.head(mediaFile.storageKey);
    if (!head.exists) {
      return NextResponse.json(
        { error: 'Upload not found in storage yet; PUT the file to the upload URL first.' },
        { status: 409 }
      );
    }

    const updated = await db.mediaFile.update({
      where: { id },
      data: { status: 'uploaded' },
    });

    if (head.sizeBytes) {
      await recordUsage(context.workspaceId, 'storage_bytes', head.sizeBytes, `media-upload:${mediaFile.id}`);
    }

    const job = await enqueuePipelineJob({
      workspaceId: context.workspaceId,
      mediaFileId: mediaFile.id,
      type: 'normalization',
      idempotencyKey: `normalize-${mediaFile.id}`,
      data: { mediaFileId: mediaFile.id },
    });

    return NextResponse.json({ mediaFile: updated, jobId: job.id });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
