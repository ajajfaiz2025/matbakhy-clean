import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../../../../../lib/db';
import { storage } from '../../../../../lib/storage';
import { resolveWorkspaceContext, WorkspaceAuthError } from '../../../../../lib/workspace';
import { blogDraftDataSchema, socialDraftDataSchema } from '../../../../../src/domain/schemas';

async function loadOwnedArtifact(artifactId: string, workspaceId: string) {
  const artifact = await db.contentArtifact.findUnique({
    where: { id: artifactId },
    include: {
      currentVersion: true,
      versions: { orderBy: { createdAt: 'desc' }, select: { id: true, model: true, tier: true, createdBy: true, createdAt: true } },
      project: { select: { workspaceId: true } },
    },
  });
  if (!artifact || artifact.project.workspaceId !== workspaceId) {
    return null;
  }
  return artifact;
}

// GET /api/v1/artifacts/{id} — retrieve one artifact's current
// version plus a lightweight version history.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id } = await params;

    const artifact = await loadOwnedArtifact(id, context.workspaceId);
    if (!artifact || !artifact.currentVersion) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }

    // short_video is the one artifact kind whose payload is a stored
    // file rather than inline text — enrich with a downloadUrl here so
    // the client doesn't need to know about the storage abstraction.
    // Every other artifact kind's response is unchanged.
    let downloadUrl: string | null = null;
    const rawBody = artifact.currentVersion.body as { kind?: string; mediaFileId?: string };
    if (rawBody?.kind === 'short_video' && rawBody.mediaFileId) {
      const mediaFile = await db.mediaFile.findUnique({ where: { id: rawBody.mediaFileId } });
      if (mediaFile) {
        downloadUrl = await storage.getSignedDownloadUrl(mediaFile.storageKey);
      }
    }

    return NextResponse.json({
      id: artifact.id,
      projectId: artifact.projectId,
      type: artifact.type,
      platform: artifact.platform,
      language: artifact.language,
      status: artifact.status,
      currentVersionId: artifact.currentVersion.id,
      body: artifact.currentVersion.body,
      downloadUrl,
      model: artifact.currentVersion.model,
      tier: artifact.currentVersion.tier,
      sourceBriefVersionId: artifact.currentVersion.sourceBriefVersionId,
      generatedAt: artifact.currentVersion.createdAt,
      versions: artifact.versions,
    });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

const editSchema = z.object({
  data: z.union([blogDraftDataSchema, socialDraftDataSchema]),
});

// PATCH /api/v1/artifacts/{id} — save a manual edit as a new version
// (section 11's "edit action"; section 2 of the architecture doc:
// "store generated outputs as versioned editable artifacts"). The
// edited body keeps the same settings/groundingMap as the version it
// was edited from — editing text doesn't change what it's grounded in.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveWorkspaceContext(request);
    const { id } = await params;
    const body = editSchema.parse(await request.json());

    const artifact = await loadOwnedArtifact(id, context.workspaceId);
    if (!artifact || !artifact.currentVersion) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }

    const previousBody = artifact.currentVersion.body as {
      kind: string;
      settings: unknown;
      groundingMap: unknown;
    };

    const newVersion = await db.$transaction(async (tx) => {
      const version = await tx.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          sourceBriefVersionId: artifact.currentVersion!.sourceBriefVersionId,
          body: {
            kind: previousBody.kind,
            data: body.data,
            settings: previousBody.settings,
            groundingMap: previousBody.groundingMap,
          } as unknown as Prisma.InputJsonValue,
          parameters: artifact.currentVersion!.parameters ?? {},
          model: null,
          createdBy: `user:${context.userId}`,
        },
      });
      await tx.contentArtifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
      return version;
    });

    return NextResponse.json({ currentVersionId: newVersion.id, body: newVersion.body });
  } catch (error) {
    if (error instanceof WorkspaceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body', issues: error.issues }, { status: 400 });
    }
    throw error;
  }
}
