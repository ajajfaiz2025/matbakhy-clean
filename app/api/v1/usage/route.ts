import { NextResponse } from 'next/server';
import { db } from '../../../../lib/db';
import { PLAN_LIMITS, getCurrentPeriodUsage } from '../../../../lib/entitlements';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../lib/workspace';
import { usageEventTypeSchema } from '../../../../src/domain/schemas';

// GET /api/v1/usage — current-period usage and limits (section 7),
// so the client can show entitlement state before the user starts an
// expensive operation.
export async function GET(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request);
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: context.workspaceId } });
    const limits = PLAN_LIMITS[workspace.planId] ?? PLAN_LIMITS.free;

    const eventTypes = usageEventTypeSchema.options;
    const usage = Object.fromEntries(
      await Promise.all(
        eventTypes.map(async (eventType) => [
          eventType,
          {
            used: await getCurrentPeriodUsage(context.workspaceId, eventType),
            limit: limits[eventType as keyof typeof limits],
          },
        ])
      )
    );

    return NextResponse.json({ planId: workspace.planId, usage });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
