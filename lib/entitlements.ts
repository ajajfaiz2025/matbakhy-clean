import { Prisma, type SocialPlatform, type UsageEventType } from '@prisma/client';
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
  // Free-trial shape (P1 fix, quality-gate section B). These are
  // standing caps checked against live entity counts, not monthly-
  // metered UsageEvent quantities like the fields above — "one
  // project ever" doesn't reset on the 1st of the month the way
  // "30 transcription minutes this month" does.
  maxActiveProjects: number;
  maxSocialPlatforms: number;
  maxExports: number;
  // Whether generated content artifacts on this plan are truncated to
  // a preview rather than the full paid output (see
  // lib/generation/previewRestriction.ts).
  previewOnly: boolean;
}

// Placeholder tiers until billing (roadmap phase 6) wires this to a
// real subscription-billing provider. This remains the single source
// of truth for both plans — there is no second/parallel entitlement
// system anywhere else in the codebase.
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    transcription_minutes: 30,
    generation_call: 5,
    render_minutes: 15,
    export_bytes: 500 * 1024 * 1024,
    storage_bytes: 2 * 1024 * 1024 * 1024,
    maxActiveProjects: 1,
    maxSocialPlatforms: 1,
    maxExports: 1,
    previewOnly: true,
  },
  creator: {
    transcription_minutes: 600,
    generation_call: 2000,
    render_minutes: 300,
    export_bytes: 20 * 1024 * 1024 * 1024,
    storage_bytes: 100 * 1024 * 1024 * 1024,
    maxActiveProjects: 100,
    maxSocialPlatforms: 3,
    maxExports: 1000,
    previewOnly: false,
  },
};

export function getPlanLimits(planId: string): PlanLimits {
  return PLAN_LIMITS[planId] ?? PLAN_LIMITS.free;
}

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
  const limits = getPlanLimits(workspace.planId);
  const limit = limits[eventType as keyof PlanLimits] as number;
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

/**
 * "One limited source/project" (free trial). Standing count, not
 * monthly — a free workspace gets exactly maxActiveProjects projects
 * for the life of the trial, not per month.
 */
export async function assertProjectLimit(workspaceId: string): Promise<void> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const limits = getPlanLimits(workspace.planId);
  const count = await db.project.count({ where: { workspaceId } });
  if (count >= limits.maxActiveProjects) {
    throw new EntitlementError(
      `Workspace ${workspaceId}'s plan allows ${limits.maxActiveProjects} project(s); it already has ${count}.`
    );
  }
}

/**
 * "One social platform only" (free trial). Scoped per project: once a
 * free-plan project has used its plan's platform allowance, requesting
 * a *different* platform is blocked — but re-requesting (regenerating)
 * an already-used platform is always allowed, since that isn't a new
 * platform. Blog generation (requestedPlatform === null) never counts
 * against this limit.
 */
export async function assertPlatformLimit(
  workspaceId: string,
  projectId: string,
  requestedPlatform: SocialPlatform | null
): Promise<void> {
  if (!requestedPlatform) return;

  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const limits = getPlanLimits(workspace.planId);

  const existing = await db.contentArtifact.findMany({
    where: { projectId, platform: { not: null } },
    select: { platform: true },
    distinct: ['platform'],
  });
  const platformSet = new Set(existing.map((row) => row.platform));

  if (!platformSet.has(requestedPlatform) && platformSet.size >= limits.maxSocialPlatforms) {
    throw new EntitlementError(
      `Workspace ${workspaceId}'s plan allows ${limits.maxSocialPlatforms} social platform(s) per project; already used: ${
        [...platformSet].join(', ') || 'none'
      }.`
    );
  }
}

/** "One free export" — a standing, lifetime count per workspace. */
export async function assertExportLimit(workspaceId: string): Promise<void> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const limits = getPlanLimits(workspace.planId);
  const count = await db.export.count({ where: { workspaceId } });
  if (count >= limits.maxExports) {
    throw new EntitlementError(
      `Workspace ${workspaceId}'s plan allows ${limits.maxExports} export(s); it has already used ${count}.`
    );
  }
}

export async function isPreviewOnlyPlan(workspaceId: string): Promise<boolean> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return getPlanLimits(workspace.planId).previewOnly;
}
