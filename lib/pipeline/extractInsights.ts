import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { getInsightProvider } from '../insights';
import { validateEditorialBrief } from '../insights/validate';
import type { InsightExtractionProvider, TranscriptSegmentInput } from '../insights/types';
import type { EditorialBrief, SupportedLanguage } from '../../src/domain/schemas';

interface ExtractInsightsData {
  projectId: string;
  audience?: string;
}

const MAX_REPAIR_ATTEMPTS = 1;

/**
 * Insight-extraction worker (section 6.3/6.4.2): compiles the
 * project's transcript into a source-grounded Editorial Brief. Runs
 * schema validation, then grounding validation (every evidence ID must
 * resolve to a real transcript segment), with one bounded repair
 * attempt on either failure before giving up (section 6.4.7) — this
 * never silently accepts an ungrounded or malformed brief.
 */
export async function extractInsights(
  job: Job<ExtractInsightsData>,
  providerOverride?: InsightExtractionProvider
): Promise<void> {
  const { projectId, audience = '' } = job.data;

  const transcript = await db.transcript.findUnique({
    where: { projectId },
    include: { segments: { orderBy: { startMs: 'asc' } } },
  });

  if (!transcript || transcript.segments.length === 0) {
    throw new Error(`Project ${projectId} has no transcript to analyze yet.`);
  }

  const language: SupportedLanguage = transcript.language === 'ar' ? 'ar' : 'en';
  const segmentInputs: TranscriptSegmentInput[] = transcript.segments.map((segment) => ({
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    speaker: segment.speaker,
  }));

  const provider = providerOverride ?? getInsightProvider();
  const extractionInput = { segments: segmentInputs, language, audience };

  let rawOutput = await provider.extract(extractionInput);
  let result = validateEditorialBrief(rawOutput, segmentInputs);

  let attempts = 0;
  while (!result.valid && attempts < MAX_REPAIR_ATTEMPTS) {
    attempts += 1;
    rawOutput = provider.repair
      ? await provider.repair(extractionInput, rawOutput, result.failure.errors)
      : await provider.extract(extractionInput);
    result = validateEditorialBrief(rawOutput, segmentInputs);
  }

  if (!result.valid) {
    throw new Error(
      `Editorial brief failed ${result.failure.stage} validation after ${attempts} repair attempt(s): ${result.failure.errors.join('; ')}`
    );
  }

  await persistEditorialBrief({ projectId, brief: result.brief, providerName: provider.name, audience });
  await db.project.update({ where: { id: projectId }, data: { status: 'ready' } });
}

async function persistEditorialBrief(params: {
  projectId: string;
  brief: EditorialBrief;
  providerName: string;
  audience: string;
}) {
  const { projectId, brief, providerName, audience } = params;

  await db.$transaction(async (tx) => {
    let artifact = await tx.contentArtifact.findFirst({ where: { projectId, type: 'editorial_brief' } });
    if (!artifact) {
      artifact = await tx.contentArtifact.create({
        data: { projectId, type: 'editorial_brief', status: 'draft', sourceRefs: [] },
      });
    }

    // Never overwrite a previous version — each successful run appends
    // a new immutable ArtifactVersion and repoints currentVersionId.
    const version = await tx.artifactVersion.create({
      data: {
        artifactId: artifact.id,
        body: brief as unknown as Prisma.InputJsonValue,
        parameters: { audience, language: brief.language },
        model: providerName,
        createdBy: 'pipeline:analysis',
      },
    });

    await tx.contentArtifact.update({
      where: { id: artifact.id },
      data: { status: 'ready', currentVersionId: version.id },
    });

    // The flat Insight rows mirror the *current* brief for independent
    // querying/filtering; full history lives in ArtifactVersion above.
    await tx.insight.deleteMany({ where: { projectId } });
    await tx.insight.createMany({ data: buildInsightRows(projectId, brief) });
  });
}

function buildInsightRows(projectId: string, brief: EditorialBrief): Prisma.InsightCreateManyInput[] {
  const span = (evidence: string[]) => {
    const entries = evidence.map((id) => brief.evidenceMap[id]).filter((entry) => entry !== undefined);
    return {
      startMs: Math.min(...entries.map((entry) => entry.startMs)),
      endMs: Math.max(...entries.map((entry) => entry.endMs)),
    };
  };

  const rows: Prisma.InsightCreateManyInput[] = [];

  for (const theme of brief.themes) {
    rows.push({ projectId, type: 'theme', text: theme.summary, segmentIds: theme.evidence, ...span(theme.evidence) });
  }
  for (const keyPoint of brief.keyPoints) {
    rows.push({
      projectId,
      type: 'key_point',
      text: keyPoint.text,
      segmentIds: keyPoint.evidence,
      ...span(keyPoint.evidence),
    });
  }
  for (const quote of brief.quotes) {
    rows.push({ projectId, type: 'quote', text: quote.text, segmentIds: quote.evidence, ...span(quote.evidence) });
  }
  for (const hook of brief.hooks) {
    rows.push({ projectId, type: 'hook', text: hook.text, segmentIds: hook.evidence, ...span(hook.evidence) });
  }
  for (const clip of brief.candidateClips) {
    rows.push({
      projectId,
      type: 'clip_candidate',
      text: clip.rationale,
      segmentIds: clip.evidence,
      startMs: clip.startMs,
      endMs: clip.endMs,
      rationale: clip.rationale,
    });
  }
  for (const claim of brief.claims) {
    rows.push({
      projectId,
      type: 'claim',
      text: claim.text,
      segmentIds: claim.evidence,
      ...span(claim.evidence),
      rationale: claim.qualification,
    });
  }
  if (brief.callToAction) {
    rows.push({
      projectId,
      type: 'call_to_action',
      text: brief.callToAction.text,
      segmentIds: brief.callToAction.evidence,
      ...span(brief.callToAction.evidence),
    });
  }

  return rows;
}
