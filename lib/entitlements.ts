import { Prisma, type UsageEventType } from '@prisma/client';
import { db } from './db';

/**
 * Usage-ledger primitives (section 8: "Usage enforcement must occur
 * before work begins and again when work completes"). Callers should
 * call assertEntitlement before starting expensive work, then
 * recordUsage once the actual cost is known.
 */
export class EntitlementError extends Error {
  status = 402;
  constructor(message: string) {
    super(message);
  }
}

interface PlanLimits {
  transcription_minutes: number;
  generation_call: number;
  render_minutes: number;
  export_bytes: number;
  storage_bytes: number;
}

// Placeholder tiers until billing (roadmap phase 6) wires this to a
// real subscription-billing provider.
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    transcription_minutes: 30,
    generation_call: 50,
    render_minutes: 15,
    export_bytes: 500 * 1024 * 1024,
    storage_bytes: 2 * 1024 * 1024 * 1024,
  },
  creator: {
    transcription_minutes: 600,
    generation_call: 2000,
    render_minutes: 300,
    export_bytes: 20 * 1024 * 1024 * 1024,
    storage_bytes: 100 * 1024 * 1024 * 1024,
  },
};

function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getCurrentPeriodUsage(
  workspaceId: string,
  eventType: UsageEventType
): Promise<number> {
  const result = await db.usageEvent.aggregate({
    where: {
      workspaceId,
      eventType,
      createdAt: { gte: currentPeriodStart() },
    },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

export async function assertEntitlement(
  workspaceId: string,
  eventType: UsageEventType,
  additionalQuantity: number
): Promise<void> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const limits = PLAN_LIMITS[workspace.planId] ?? PLAN_LIMITS.free;
  const limit = limits[eventType as keyof PlanLimits];
  const used = await getCurrentPeriodUsage(workspaceId, eventType);

  if (used + additionalQuantity > limit) {
    throw new EntitlementError(
      `Workspace ${workspaceId} would exceed its ${eventType} limit for the current period (${used + additionalQuantity} > ${limit}).`
    );
  }
}

// Idempotent: a retried job reusing the same idempotencyKey is a no-op
// rather than double-charging usage (section 6.2).
export async function recordUsage(
  workspaceId: string,
  eventType: UsageEventType,
  quantity: number,
  idempotencyKey: string
): Promise<void> {
  try {
    await db.usageEvent.create({
      data: { workspaceId, eventType, quantity, idempotencyKey },
    });
  } catch (error) {
    const isDuplicate =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    if (!isDuplicate) {
      throw error;
    }
  }
}
