import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { storage } from '../lib/storage';
import { generateSyntheticVideo } from '../tests/rendering/fixtures';
import { probeMedia } from '../lib/rendering/ffmpeg';
import { extractInsights } from '../lib/pipeline/extractInsights';
import { generateContent } from '../lib/pipeline/generateContent';
import { renderShortVideo } from '../lib/pipeline/renderShortVideo';
import { getInsightProvider } from '../lib/insights';
import { getContentProviders } from '../lib/generation';
import { enqueueRenderJob } from '../lib/rendering/enqueue';
import { editorialBriefSchema } from '../src/domain/schemas';

/**
 * Real LLM Integration & Validation — the ONE command to run once a
 * real OPENAI_API_KEY is available. See docs/real-llm-validation.md
 * for the full readiness write-up this script is the executable half
 * of. It does NOT replace the mock provider or change how routing
 * works — it just drives the exact same 4-input validation set used
 * in the prior (mock-only) Product Validation Report through whatever
 * lib/insights and lib/generation's own routers (getInsightProvider,
 * getContentProviders) resolve to, so it fails the same way a real
 * user's request would if misconfigured.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/realLlmValidation.ts
 *   (or: npm run validate:real, with the key exported in your shell)
 *
 * Cost note: this makes real OpenAI API calls — 4 insight-extraction
 * calls (+ possible repair/reconcile retries) and 16 generation calls
 * (4 platforms x 4 inputs), all against short (<1000-token) prompts.
 * See docs/real-llm-validation.md for a cost estimate.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const db = new PrismaClient({ adapter });

const OUT_DIR = path.join(process.cwd(), '.data', 'real-validation-results', new Date().toISOString().replace(/[:.]/g, '-'));

const MOCK_MARKERS = ['[mock', '[ملخص تجريبي', '[مسودة تجريبية', '[تجريبي]'];

interface SegFixture { text: string; startMs: number; endMs: number; }
interface Profile { key: string; label: string; language: 'ar' | 'en'; segments: SegFixture[]; }

// Identical fixtures to the prior (mock-only) validation reports, so
// results are directly comparable before/after a real provider.
const PROFILES: Profile[] = [
  {
    key: 'gulf-conversational', label: 'Arabic Saudi/Gulf conversational content', language: 'ar',
    segments: [
      { text: 'يا خوي والله من زمان أبي أسولف وياك عن هالمشروع اللي بديته', startMs: 0, endMs: 4000 },
      { text: 'بصراحة أول شي كان صعب علي أحدد أي منتج أبيع، جربت أكثر من فكرة قبل لا ألقى اللي يناسبني، وأخيراً قررت أشتغل بالعطورات لأن الطلب عليها كبير في السوق المحلي', startMs: 4000, endMs: 11000 },
      { text: 'أول شهر بعت بس خمس قطع، كان محبط شوي بصراحة', startMs: 11000, endMs: 15000 },
      { text: 'بس بعدين غيرت الاستراتيجية، صرت أسوي فيديوهات قصيرة أوريهم فيها كيف أسوي العطر، والناس تفاعلوا وايد', startMs: 15000, endMs: 21000 },
      { text: 'الشهر اللي بعده وصلت مبيعاتي لأكثر من ثمانين قطعة، يعني تضاعفت أكثر من عشر مرات', startMs: 21000, endMs: 26000 },
      { text: 'أهم درس تعلمته إن المحتوى أهم من الإعلانات المدفوعة في البداية', startMs: 26000, endMs: 30000 },
      { text: 'لو حاب تبدأ مشروعك الخاص، ابدأ صغير وما تخاف من الغلط', startMs: 30000, endMs: 34000 },
      { text: 'تابعوني في حسابي عشان أشارك معكم التفاصيل أكثر', startMs: 34000, endMs: 38000 },
    ],
  },
  {
    key: 'msa-educational', label: 'Arabic educational/business content (MSA)', language: 'ar',
    segments: [
      { text: 'أهلاً وسهلاً بكم في هذه الحلقة، سنتحدث اليوم عن أساسيات الاستثمار الشخصي للمبتدئين', startMs: 0, endMs: 5000 },
      { text: 'القاعدة الأولى في الاستثمار هي أن تفهم الفرق بين الادخار والاستثمار، فالادخار هو وضع المال جانباً دون مخاطرة، بينما الاستثمار يعني توظيف المال في أصول قد تنمو بمرور الوقت مقابل تحمل بعض المخاطر', startMs: 5000, endMs: 13000 },
      { text: 'الدراسات تشير إلى أن من يبدأ الاستثمار في سن مبكرة يحقق عوائد أكبر بكثير بسبب فائدة النمو المركب', startMs: 13000, endMs: 18000 },
      { text: 'على سبيل المثال، الشخص الذي يستثمر خمسمائة ريال شهرياً بدءاً من عمر عشرين عاماً', startMs: 18000, endMs: 23000 },
      { text: 'يمكن أن يصل إلى أكثر من مليون ريال عند التقاعد، بينما من يبدأ في سن الثلاثين يحصل على أقل من نصف هذا المبلغ', startMs: 23000, endMs: 29000 },
      { text: 'لذلك، لا تنتظر حتى يكون لديك مبلغ كبير لتبدأ، ابدأ بما تستطيع الآن', startMs: 29000, endMs: 34000 },
      { text: 'في الحلقة القادمة سنتحدث عن كيفية اختيار صندوق الاستثمار المناسب', startMs: 34000, endMs: 38000 },
    ],
  },
  {
    key: 'en-podcast', label: 'English podcast/interview content', language: 'en',
    segments: [
      { text: "Welcome back to the show, today we're talking with Sarah about how she found product-market fit.", startMs: 0, endMs: 4000 },
      { text: 'Thanks for having me, excited to be here.', startMs: 4000, endMs: 6000 },
      { text: 'So the biggest mistake we made in year one was building features nobody asked for, we spent almost six months building a mobile app before we even talked to ten real customers, and honestly that set us back almost a full year of runway.', startMs: 6000, endMs: 15000 },
      { text: 'Wow, six months is a long time to build something without validation.', startMs: 15000, endMs: 19000 },
      { text: 'Exactly, and the turning point was when we started doing weekly customer calls, just fifteen minutes each.', startMs: 19000, endMs: 24000 },
      { text: 'Within two months we found the one feature that actually mattered, and our retention went from twelve percent to forty five percent.', startMs: 24000, endMs: 29000 },
      { text: "That's a massive jump, what changed specifically in the product?", startMs: 29000, endMs: 33000 },
      { text: 'We stopped trying to be everything for everyone and focused on one very specific workflow for one type of user.', startMs: 33000, endMs: 39000 },
      { text: 'If founders take one thing from this episode, talk to your customers before you write a single line of code.', startMs: 39000, endMs: 43000 },
    ],
  },
  {
    key: 'gulf-codeswitch', label: 'Arabic-English code-switched content (Gulf tech)', language: 'ar',
    segments: [
      { text: 'اليوم بنتكلم عن كيف نقيس نجاح الـ startup في المراحل الأولى', startMs: 0, endMs: 4000 },
      { text: 'أهم شي هو الـ product-market fit، لأن بدونه أي مبلغ تجمعه من الـ investors بينحرق بسرعة', startMs: 4000, endMs: 11000 },
      { text: 'احنا في شركتنا كنا نراقب الـ churn rate كل أسبوع، مو كل شهر', startMs: 11000, endMs: 16000 },
      { text: 'لما شفنا الـ churn يرتفع فوق خمسة بالمية شهرياً، عرفنا إن فيه مشكلة حقيقية في الـ onboarding experience', startMs: 16000, endMs: 23000 },
      { text: 'غيرنا تجربة أول خمس دقايق بالكامل، وخلال شهرين نزل الـ churn لأقل من اثنين بالمية', startMs: 23000, endMs: 28000 },
      { text: 'الـ MRR بعدها زاد ثلاثة أضعاف خلال سنة وحدة، وهذا كله بدون ما نزيد ميزانية التسويق', startMs: 28000, endMs: 33000 },
      { text: 'نصيحتي لأي مؤسس: راقب أرقامك الأسبوعية، مو الشهرية فقط', startMs: 33000, endMs: 37000 },
    ],
  },
];

function scanForMockMarkers(text: string): string[] {
  return MOCK_MARKERS.filter((marker) => text.includes(marker));
}

async function runProfile(profile: Profile) {
  console.log(`\n=== ${profile.key}: ${profile.label} ===`);
  const outDir = path.join(OUT_DIR, profile.key);
  await mkdir(outDir, { recursive: true });
  const flags: string[] = [];

  const workspace = await db.workspace.create({
    data: { id: `real-validation-${profile.key}-${randomUUID().slice(0, 8)}`, name: `Real validation: ${profile.label}`, planId: 'creator' },
  });

  const totalDurationMs = profile.segments[profile.segments.length - 1].endMs;
  const storageKey = `${workspace.id}/${randomUUID()}-source.mp4`;
  const localPath = storage.resolve(storageKey);
  await generateSyntheticVideo({
    outputPath: localPath,
    durationSeconds: Math.ceil(totalDurationMs / 1000) + 2,
    width: 1280,
    height: 720,
    withAudio: true,
  });
  const sourceProbe = await probeMedia(localPath, 30_000);

  const mediaFile = await db.mediaFile.create({
    data: { workspaceId: workspace.id, kind: 'source', storageKey, mimeType: 'video/mp4', status: 'normalized', durationMs: sourceProbe.durationMs, checksum: randomUUID() },
  });
  const project = await db.project.create({
    data: { workspaceId: workspace.id, title: profile.label, sourceMediaId: mediaFile.id, status: 'ready' },
  });

  // NOTE: transcription itself is NOT exercised against a real
  // Whisper call here — there is no real speech audio in this
  // environment (only a synthetic test-pattern video), so a real
  // Whisper call would just transcribe silence/tone, not produce a
  // meaningful result. The transcript below stands in for "what
  // transcription would have produced," exactly as in the prior
  // mock-only validation, so insight extraction and generation are
  // being tested against realistic, comparable content. If real
  // audio becomes available, point this script at it instead (see
  // docs/real-llm-validation.md).
  await db.transcript.create({
    data: {
      projectId: project.id,
      provider: 'real-validation-fixture (hand-authored, NOT real ASR output)',
      language: profile.language,
      segments: { create: profile.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, speaker: null })) },
    },
  });

  const insightProvider = getInsightProvider();
  console.log(`  insight provider: ${insightProvider.name}`);
  await extractInsights(
    { data: { projectId: project.id, audience: profile.language === 'ar' ? 'رواد أعمال' : 'founders' } } as Parameters<typeof extractInsights>[0],
    insightProvider
  );
  const briefArtifact = await db.contentArtifact.findFirstOrThrow({
    where: { projectId: project.id, type: 'editorial_brief' },
    include: { currentVersion: true },
  });
  if (!briefArtifact.currentVersion!.model?.startsWith('openai')) {
    flags.push(`Editorial brief model was "${briefArtifact.currentVersion!.model}", not openai:* — check OPENAI_API_KEY.`);
  }
  const brief = editorialBriefSchema.parse(briefArtifact.currentVersion!.body);
  const briefMarkers = scanForMockMarkers(JSON.stringify(brief));
  if (briefMarkers.length > 0) flags.push(`Editorial brief contains mock markers: ${briefMarkers.join(', ')}`);
  await writeFile(path.join(outDir, 'editorial_brief.json'), JSON.stringify(brief, null, 2));

  const { primary, fallback } = getContentProviders();
  console.log(`  generation provider: primary=${primary.name} fallback=${fallback?.name ?? 'none'}`);
  const generationTargets: Array<{ artifactType: 'blog_draft' | 'social_post' | 'caption'; platform: 'x' | 'linkedin' | 'instagram' | null }> = [
    { artifactType: 'blog_draft', platform: null },
    { artifactType: 'social_post', platform: 'x' },
    { artifactType: 'social_post', platform: 'linkedin' },
    { artifactType: 'caption', platform: 'instagram' },
  ];
  for (const target of generationTargets) {
    await generateContent(
      {
        data: {
          projectId: project.id, artifactType: target.artifactType, platform: target.platform,
          language: profile.language, tone: 'informative', audience: profile.language === 'ar' ? 'رواد أعمال' : 'founders',
        },
      } as Parameters<typeof generateContent>[0],
      { primary, fallback }
    );
  }
  const artifacts = await db.contentArtifact.findMany({
    where: { projectId: project.id, type: { not: 'editorial_brief' } },
    include: { currentVersion: true },
  });
  const generatedDump = artifacts.map((a) => {
    const model = a.currentVersion?.model ?? null;
    if (!model?.startsWith('openai')) {
      flags.push(`${a.type}/${a.platform ?? 'none'} model was "${model}" — likely silently fell back to mock (check for an outright OpenAI failure above).`);
    }
    const bodyStr = JSON.stringify(a.currentVersion?.body ?? {});
    const markers = scanForMockMarkers(bodyStr);
    if (markers.length > 0) flags.push(`${a.type}/${a.platform ?? 'none'} contains mock markers: ${markers.join(', ')}`);
    return { type: a.type, platform: a.platform, model, body: a.currentVersion?.body };
  });
  await writeFile(path.join(outDir, 'generated_content.json'), JSON.stringify(generatedDump, null, 2));

  const renderResults: unknown[] = [];
  for (const clip of brief.candidateClips) {
    const enqueueResult = await enqueueRenderJob({ workspaceId: workspace.id, projectId: project.id, candidateClipId: clip.id });
    const renderJobRow = await db.renderJob.findUniqueOrThrow({ where: { id: enqueueResult.renderJobId } });
    await renderShortVideo(
      {
        id: renderJobRow.idempotencyKey,
        data: {
          renderJobId: renderJobRow.id, artifactId: enqueueResult.artifactId, projectId: project.id,
          candidateClipId: clip.id, sourceBriefVersionId: renderJobRow.sourceBriefVersionId, sourceMediaId: renderJobRow.sourceMediaId,
        },
        attemptsMade: 0, opts: { attempts: 5 },
      } as unknown as Parameters<typeof renderShortVideo>[0]
    );
    const artifact = await db.contentArtifact.findUniqueOrThrow({ where: { id: enqueueResult.artifactId }, include: { currentVersion: true } });
    renderResults.push({ clipId: clip.id, clip, artifactStatus: artifact.status, body: artifact.currentVersion!.body });
  }
  await writeFile(path.join(outDir, 'render_results.json'), JSON.stringify(renderResults, null, 2));

  if (flags.length > 0) {
    console.log('  ⚠ FLAGS:');
    flags.forEach((f) => console.log(`    - ${f}`));
  } else {
    console.log('  ✓ no mock-fallback or mock-marker flags');
  }
  console.log(`  workspace=${workspace.id} project=${project.id} candidateClips=${brief.candidateClips.length}`);

  return { profile: profile.key, workspaceId: workspace.id, projectId: project.id, flags };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '\nOPENAI_API_KEY is not set. This script exists to validate the REAL provider — running it ' +
        'without a key would just re-run the mock path, which is already covered by `npm test`.\n' +
        'Set OPENAI_API_KEY and re-run: OPENAI_API_KEY=sk-... npx tsx scripts/realLlmValidation.ts\n'
    );
    process.exit(1);
  }

  console.log('Real LLM Integration & Validation');
  console.log('==================================');
  console.log(`INSIGHT_PROVIDER=${process.env.INSIGHT_PROVIDER ?? '(unset — auto-detect from key)'}`);
  console.log(`GENERATION_PROVIDER=${process.env.GENERATION_PROVIDER ?? '(unset — auto-detect from key)'}`);
  console.log(`Output directory: ${OUT_DIR}`);

  await mkdir(OUT_DIR, { recursive: true });
  const results = [];
  for (const profile of PROFILES) {
    results.push(await runProfile(profile));
  }
  await writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));

  const totalFlags = results.reduce((sum, r) => sum + r.flags.length, 0);
  console.log('\n==================================');
  console.log(`Done. ${results.length} inputs processed, ${totalFlags} flag(s) across all inputs.`);
  console.log(`Full output: ${OUT_DIR}`);
  console.log(
    'Next: review editorial_brief.json / generated_content.json / render_results.json per input and ' +
      'score against the REAL LLM SCORECARD rubric in docs/real-llm-validation.md. Workspace IDs above ' +
      'are left in the database for inspection — clean up manually when done.'
  );
  process.exit(totalFlags > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
