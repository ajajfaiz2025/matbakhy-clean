import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import { extractInsights } from '../lib/pipeline/extractInsights';
import { mockInsightProvider } from '../lib/insights/mockProvider';

export async function createTestWorkspace() {
  return db.workspace.create({
    data: { id: `test-ws-${randomUUID()}`, name: 'Test Workspace', planId: 'free' },
  });
}

interface SegmentFixture {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string | null;
}

export async function createTestProjectWithTranscript(params: {
  workspaceId: string;
  language: string;
  segments: SegmentFixture[];
}) {
  const mediaFile = await db.mediaFile.create({
    data: {
      workspaceId: params.workspaceId,
      kind: 'source',
      storageKey: `test/${randomUUID()}`,
      mimeType: 'video/mp4',
      status: 'normalized',
      checksum: randomUUID(),
    },
  });

  const project = await db.project.create({
    data: { workspaceId: params.workspaceId, title: 'Test Project', sourceMediaId: mediaFile.id, status: 'ready' },
  });

  const transcript = await db.transcript.create({
    data: {
      projectId: project.id,
      provider: 'test-fixture',
      language: params.language,
      segments: {
        create: params.segments.map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          speaker: segment.speaker ?? null,
        })),
      },
    },
    include: { segments: { orderBy: { startMs: 'asc' } } },
  });

  return { mediaFile, project, transcript };
}

export async function cleanupWorkspace(workspaceId: string): Promise<void> {
  await db.workspace.delete({ where: { id: workspaceId } }).catch((error) => {
    console.warn(`Failed to clean up test workspace ${workspaceId}:`, error);
  });
}

const ENGLISH_SEGMENTS: SegmentFixture[] = [
  { text: 'Welcome, today we discuss growth.', startMs: 0, endMs: 4000 },
  { text: 'When we started, we had just two customers. Within eighteen months we grew to 4000 paying customers.', startMs: 4000, endMs: 12000 },
  { text: 'Our revenue grew by 300 percent last year, mostly from word of mouth referrals.', startMs: 12000, endMs: 18000 },
  { text: 'The biggest lesson we learned is that talking to customers every single week changes everything.', startMs: 18000, endMs: 24000 },
  { text: 'If you found this useful, please subscribe to the channel and share it with a friend.', startMs: 24000, endMs: 30000 },
];

const ARABIC_SEGMENTS: SegmentFixture[] = [
  { text: 'أهلاً بكم، سنتحدث اليوم عن النمو.', startMs: 0, endMs: 4000 },
  { text: 'عندما بدأنا، كان لدينا عميلان فقط. خلال ثمانية عشر شهرًا نمونا إلى 4000 عميل مدفوع.', startMs: 4000, endMs: 12000 },
  { text: 'نمت إيراداتنا بنسبة 300 بالمئة العام الماضي، معظمها من الإحالات الشفهية.', startMs: 12000, endMs: 18000 },
  { text: 'أهم درس تعلمناه هو أن التحدث إلى العملاء كل أسبوع يغير كل شيء.', startMs: 18000, endMs: 24000 },
  { text: 'إذا أعجبك هذا المحتوى، يرجى الاشتراك في القناة ومشاركتها مع صديق.', startMs: 24000, endMs: 30000 },
];

/**
 * A project with a real, validated, fully-grounded Editorial Brief and
 * its Insight rows already persisted — built by actually running the
 * (separately tested) extractInsights pipeline with the mock insight
 * provider, rather than hand-rolling fixture data that could drift
 * from the real schema.
 */
export async function createTestProjectWithBrief(language: 'en' | 'ar' = 'en') {
  const workspace = await createTestWorkspace();
  const { project, transcript } = await createTestProjectWithTranscript({
    workspaceId: workspace.id,
    language,
    segments: language === 'ar' ? ARABIC_SEGMENTS : ENGLISH_SEGMENTS,
  });

  await extractInsights(
    { data: { projectId: project.id, audience: '' } } as Parameters<typeof extractInsights>[0],
    mockInsightProvider
  );

  const insights = await db.insight.findMany({ where: { projectId: project.id } });
  const briefArtifact = await db.contentArtifact.findFirstOrThrow({
    where: { projectId: project.id, type: 'editorial_brief' },
  });

  return { workspace, project, transcript, insights, briefArtifact };
}
