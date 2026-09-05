import type { Job } from 'bullmq';
import { db } from '../db';
import { storage } from '../storage';
import { getTranscriptionProvider } from '../transcription';

interface TranscribeMediaData {
  projectId: string;
  mediaFileId: string;
}

/**
 * Transcription worker (section 6.2): runs the selected provider
 * against the normalized source and persists the result as the
 * project's transcript + timestamped segments. Idempotent at the
 * queue level (see lib/queue.ts) — a retry reuses the same PipelineJob
 * row rather than creating a second transcript.
 */
export async function transcribeMedia(job: Job<TranscribeMediaData>): Promise<void> {
  const { projectId, mediaFileId } = job.data;

  const mediaFile = await db.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
  await db.project.update({ where: { id: projectId }, data: { status: 'processing' } });

  const provider = getTranscriptionProvider();
  const filePath = storage.resolve(mediaFile.storageKey);
  const result = await provider.transcribe({ filePath });

  await db.transcript.upsert({
    where: { projectId },
    update: {
      provider: provider.name,
      language: result.language,
      confidence: result.confidence,
      segments: { deleteMany: {}, create: result.segments },
    },
    create: {
      projectId,
      provider: provider.name,
      language: result.language,
      confidence: result.confidence,
      segments: { create: result.segments },
    },
  });

  await db.project.update({ where: { id: projectId }, data: { status: 'ready' } });
}
