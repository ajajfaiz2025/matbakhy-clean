import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';

export async function createTestWorkspace() {
  return db.workspace.create({
    data: { id: `test-ws-${randomUUID()}`, name: 'Test Workspace', planId: 'free' },
  });
}

interface SegmentFixture {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string | null;
}

export async function createTestProjectWithTranscript(params: {
  workspaceId: string;
  language: string;
  segments: SegmentFixture[];
}) {
  const mediaFile = await db.mediaFile.create({
    data: {
      workspaceId: params.workspaceId,
      kind: 'source',
      storageKey: `test/${randomUUID()}`,
      mimeType: 'video/mp4',
      status: 'normalized',
      checksum: randomUUID(),
    },
  });

  const project = await db.project.create({
    data: { workspaceId: params.workspaceId, title: 'Test Project', sourceMediaId: mediaFile.id, status: 'ready' },
  });

  const transcript = await db.transcript.create({
    data: {
      projectId: project.id,
      provider: 'test-fixture',
      language: params.language,
      segments: {
        create: params.segments.map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          speaker: segment.speaker ?? null,
        })),
      },
    },
    include: { segments: { orderBy: { startMs: 'asc' } } },
  });

  return { mediaFile, project, transcript };
}

export async function cleanupWorkspace(workspaceId: string): Promise<void> {
  await db.workspace.delete({ where: { id: workspaceId } }).catch((error) => {
    console.warn(`Failed to clean up test workspace ${workspaceId}:`, error);
  });
}
