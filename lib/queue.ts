import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { PipelineJob, PipelineJobType } from '@prisma/client';
import { db } from './db';

const PIPELINE_QUEUE_NAME = 'pipeline-jobs';

let connection: IORedis | undefined;

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

export const pipelineQueue = new Queue(PIPELINE_QUEUE_NAME, { connection: getConnection() });

interface EnqueueParams<T> {
  workspaceId: string;
  projectId?: string;
  mediaFileId?: string;
  type: PipelineJobType;
  idempotencyKey: string;
  data: T;
  attempts?: number;
}

// Idempotent on idempotencyKey (section 6.2): a retried request for
// the same underlying work — same source checksum + config fingerprint
// — reuses the existing PipelineJob row and BullMQ job instead of
// double-processing or double-charging usage.
export async function enqueuePipelineJob<T>(params: EnqueueParams<T>): Promise<PipelineJob> {
  const { workspaceId, projectId, mediaFileId, type, idempotencyKey, data, attempts = 5 } = params;

  const job = await db.pipelineJob.upsert({
    where: { idempotencyKey },
    update: {},
    create: { workspaceId, projectId, mediaFileId, type, idempotencyKey, status: 'queued' },
  });

  await pipelineQueue.add(type, data, {
    jobId: idempotencyKey,
    attempts,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: false,
  });

  return job;
}

export type PipelineJobHandler = (job: Job) => Promise<void>;
export type PipelineHandlers = Partial<Record<PipelineJobType, PipelineJobHandler>>;

// One BullMQ Worker fans out to per-type handlers, and mirrors status
// into the PipelineJob table so GET /api/v1/jobs/{id} (and any future
// SSE/WebSocket progress stream) has a stage-agnostic place to read
// progress, retries, and dead-letter state from (section 7-8).
export function startPipelineWorker(handlers: PipelineHandlers): Worker {
  const worker = new Worker(
    PIPELINE_QUEUE_NAME,
    async (job) => {
      const handler = handlers[job.name as PipelineJobType];
      if (!handler) {
        throw new Error(`No handler registered for pipeline job type "${job.name}"`);
      }
      await db.pipelineJob.update({
        where: { idempotencyKey: job.id! },
        data: { status: 'running', attempt: job.attemptsMade + 1 },
      });
      await handler(job);
    },
    { connection: getConnection() }
  );

  worker.on('completed', (job) => {
    db.pipelineJob
      .update({ where: { idempotencyKey: job.id! }, data: { status: 'succeeded', progress: 1 } })
      .catch((error) => console.error('Failed to record job completion', error));
  });

  worker.on('failed', (job, error) => {
    if (!job?.id) return;
    const willRetry = job.attemptsMade < (job.opts.attempts ?? 1);
    db.pipelineJob
      .update({
        where: { idempotencyKey: job.id },
        data: { status: willRetry ? 'retrying' : 'dead_letter', error: error.message.slice(0, 2000) },
      })
      .catch((updateError) => console.error('Failed to record job failure', updateError));
  });

  return worker;
}
