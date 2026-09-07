import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '../../../../../../lib/db';
import { EntitlementError } from '../../../../../../lib/entitlements';
import { enqueueGenerationJob, NoEditorialBriefError } from '../../../../../../lib/generation/enqueue';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';
import type { GenerationSettings } from '../../../../../../src/domain/schemas';

const requestSchema = z.object({
  tone: z.string().max(100).optional(),
  audience: z.string().max(200).optional(),
  dialect: z.string().max(100).optional(),
});

// POST /api/v1/artifacts/{id}/regenerate — re-run generation for an
// existing artifact (section 9). Any setting omitted from the request
// body is carried forward from the artifact's current version. An
// explicit regenerate always attempts a new version, even with
// byte-identical settings — see enqueueGenerationJob's regenerateFrom
// for why that doesn't conflict with idempotency on the plain
// "generate" endpoint.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id } = await params;
    const overrides = requestSchema.parse(request.headers.get('content-length') !== '0' ? await request.json().catch(() => ({})) : {});

    const artifact = await db.contentArtifact.findUnique({
      where: { id },
      include: { currentVersion: true, project: { select: { workspaceId: true } } },
    });
    if (!artifact || artifact.project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }
    if (artifact.type === 'editorial_brief') {
      return NextResponse.json(
        { error: 'Use POST /api/v1/projects/{id}/analysis to regenerate the Editorial Brief.' },
        { status: 400 }
      );
    }
    if (artifact.type === 'short_video') {
      return NextResponse.json(
        { error: 'Use POST /api/v1/projects/{id}/render to (re-)render a short video — this endpoint is for text content only.' },
        { status: 400 }
      );
    }

    const previousSettings = artifact.currentVersion?.body
      ? ((artifact.currentVersion.body as { settings?: GenerationSettings }).settings ?? null)
      : null;

    const result = await enqueueGenerationJob({
      workspaceId: context.workspaceId,
      projectId: artifact.projectId,
      artifactType: artifact.type as 'blog_draft' | 'social_post' | 'caption',
      platform: artifact.platform,
      language: artifact.language as 'ar' | 'en',
      tone: overrides.tone ?? previousSettings?.tone ?? 'neutral',
      audience: overrides.audience ?? previousSettings?.audience ?? '',
      dialect: overrides.dialect ?? previousSettings?.dialect,
      regenerateFrom: artifact.currentVersionId ?? 'initial',
    });

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EntitlementError || error instanceof NoEditorialBriefError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body', issues: error.issues }, { status: 400 });
    }
    throw error;
  }
}
