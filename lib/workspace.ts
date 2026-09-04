import { db } from './db';
import type { Role } from '../src/domain/schemas';

/**
 * Dev-mode auth stub. The architecture doc recommends a managed
 * identity provider (section 4.1/9) for real session handling; until
 * that's wired up, the workspace and user are resolved from headers so
 * the rest of the API surface (entitlements, uploads, projects) can be
 * built and tested against a real tenancy boundary.
 */
export class WorkspaceAuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: Role;
}

export async function resolveWorkspaceContext(request: Request): Promise<WorkspaceContext> {
  const workspaceId = request.headers.get('x-workspace-id');
  const userId = request.headers.get('x-user-id');

  if (!workspaceId || !userId) {
    throw new WorkspaceAuthError(
      'Missing x-workspace-id / x-user-id headers (dev auth stub — replace with real session auth).'
    );
  }

  const membership = await db.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });

  if (!membership || membership.status !== 'active') {
    throw new WorkspaceAuthError('No active membership for this workspace.', 403);
  }

  return { workspaceId, userId, role: membership.role };
}

export function requireRole(context: WorkspaceContext, allowed: Role[]): void {
  if (!allowed.includes(context.role)) {
    throw new WorkspaceAuthError(`Role '${context.role}' is not permitted for this action.`, 403);
  }
}
