import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '../../../../../../lib/db';
import { EntitlementError } from '../../../../../../lib/entitlements';
import { enqueueGenerationJob, NoEditorialBriefError } from '../../../../../../lib/generation/enqueue';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../../lib/workspace';
import { generationArtifactTypeSchema, socialPlatformSchema, supportedLanguageSchema } from '../../../../../../src/domain/schemas';

const requestSchema = z
  .object({
    artifactType: generationArtifactTypeSchema,
    platform: socialPlatformSchema.optional(),
    language: supportedLanguageSchema,
    tone: z.string().max(100).optional(),
    audience: z.string().max(200).optional(),
    dialect: z.string().max(100).optional(),
  })
  .refine((value) => value.artifactType === 'blog_draft' || value.platform, {
    message: 'platform is required for social_post/caption artifacts',
    path: ['platform'],
  });

// POST /api/v1/projects/{id}/content — generate a blog draft or a
// platform-aware social post/caption from the project's current
// Editorial Brief (section 10).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id: projectId } = await params;
    const body = requestSchema.parse(await request.json());

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== context.workspaceId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const result = await enqueueGenerationJob({
      workspaceId: context.workspaceId,
      projectId,
      artifactType: body.artifactType,
      platform: body.platform ?? null,
      language: body.language,
      tone: body.tone ?? 'neutral',
      audience: body.audience ?? '',
      dialect: body.dialect,
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
