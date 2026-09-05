import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import type { Job } from 'bullmq';
import { db } from '../db';
import { storage } from '../storage';

const execFileAsync = promisify(execFile);

interface NormalizeMediaData {
  mediaFileId: string;
}

function computeChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

interface ProbeResult {
  durationMs: number | null;
}

async function probeMedia(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const durationSeconds = parsed.format?.duration ? Number(parsed.format.duration) : null;
  return { durationMs: durationSeconds ? Math.round(durationSeconds * 1000) : null };
}

/**
 * Normalization worker (section 6.1): validates the uploaded file and
 * extracts duration via FFmpeg's ffprobe. Requires ffprobe on the
 * worker's PATH — if it's missing this throws (and BullMQ retries with
 * backoff per the queue config), since that's an infrastructure
 * problem rather than a bad upload; only a genuinely invalid/corrupt
 * file should mark the MediaFile "failed".
 */
export async function normalizeMedia(job: Job<NormalizeMediaData>): Promise<void> {
  const { mediaFileId } = job.data;
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  const mediaFile = await db.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
  await db.mediaFile.update({ where: { id: mediaFileId }, data: { status: 'validating' } });

  const filePath = storage.resolve(mediaFile.storageKey);
  const checksum = await computeChecksum(filePath);

  try {
    const probe = await probeMedia(filePath);
    await db.mediaFile.update({
      where: { id: mediaFileId },
      data: { status: 'normalized', checksum, durationMs: probe.durationMs },
    });
  } catch (error) {
    const isMissingBinary = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (isLastAttempt) {
      await db.mediaFile.update({ where: { id: mediaFileId }, data: { status: 'failed', checksum } });
    }
    throw isMissingBinary
      ? new Error('ffprobe is not installed on this worker (install FFmpeg to enable normalization).')
      : error;
  }
}
