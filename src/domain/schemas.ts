import { z } from 'zod';

/**
 * Core domain schemas for the AI-Powered Content Repurposing Tool.
 * Mirrors the domain model in the technical architecture doc (section 5):
 * source media is kept separate from derived artifacts, and mutable
 * user-facing artifacts are versioned so edits and generation prompts
 * stay auditable and regenerable.
 */

export const roleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

export const membershipStatusSchema = z.enum(['active', 'invited', 'suspended']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  planId: z.string(),
  settings: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.coerce.date(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const membershipSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: roleSchema,
  status: membershipStatusSchema,
});
export type Membership = z.infer<typeof membershipSchema>;

export const projectStatusSchema = z.enum([
  'draft',
  'processing',
  'ready',
  'failed',
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1),
  status: projectStatusSchema,
  sourceMediaId: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type Project = z.infer<typeof projectSchema>;

export const mediaFileKindSchema = z.enum([
  'source',
  'proxy',
  'rendered',
]);
export type MediaFileKind = z.infer<typeof mediaFileKindSchema>;

export const mediaFileStatusSchema = z.enum([
  'uploading',
  'uploaded',
  'validating',
  'normalized',
  'failed',
]);
export type MediaFileStatus = z.infer<typeof mediaFileStatusSchema>;

export const mediaFileSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: mediaFileKindSchema,
  storageKey: z.string(),
  mimeType: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  checksum: z.string().nullable(),
  status: mediaFileStatusSchema,
  createdAt: z.coerce.date(),
});
export type MediaFile = z.infer<typeof mediaFileSchema>;

export const transcriptSegmentSchema = z.object({
  id: z.string(),
  transcriptId: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  speaker: z.string().nullable(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.string(),
  language: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  segments: z.array(transcriptSegmentSchema).optional(),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const insightTypeSchema = z.enum([
  'theme',
  'key_point',
  'quote',
  'hook',
  'clip_candidate',
  'chapter',
  'call_to_action',
  'claim',
]);
export type InsightType = z.infer<typeof insightTypeSchema>;

export const insightSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: insightTypeSchema,
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  segmentIds: z.array(z.string()),
  score: z.number().min(0).max(1).nullable(),
  rationale: z.string().nullable(),
});
export type Insight = z.infer<typeof insightSchema>;

export const artifactTypeSchema = z.enum([
  'editorial_brief',
  'blog_post',
  'social_caption',
  'title',
  'summary',
  'chapter_list',
  'short_video',
  'quote_card',
  'metadata',
]);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const artifactStatusSchema = z.enum([
  'draft',
  'generating',
  'ready',
  'failed',
]);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

export const contentArtifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: artifactTypeSchema,
  status: artifactStatusSchema,
  sourceRefs: z.array(z.string()).default([]),
  currentVersionId: z.string().nullable(),
});
export type ContentArtifact = z.infer<typeof contentArtifactSchema>;

export const artifactVersionSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  body: z.record(z.string(), z.unknown()),
  parameters: z.record(z.string(), z.unknown()).default({}),
  model: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'retrying',
  'dead_letter',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const renderJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  artifactId: z.string(),
  candidateClipId: z.string(),
  sourceBriefVersionId: z.string(),
  sourceMediaId: z.string(),
  template: z.string(),
  status: jobStatusSchema,
  progress: z.number().min(0).max(1),
  outputMediaId: z.string().nullable(),
  error: z.string().nullable(),
});
export type RenderJob = z.infer<typeof renderJobSchema>;

export const usageEventTypeSchema = z.enum([
  'transcription_minutes',
  'generation_call',
  'render_minutes',
  'export_bytes',
  'storage_bytes',
]);
export type UsageEventType = z.infer<typeof usageEventTypeSchema>;

export const usageEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  eventType: usageEventTypeSchema,
  quantity: z.number().nonnegative(),
  idempotencyKey: z.string(),
  createdAt: z.coerce.date(),
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

export const exportStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type ExportStatus = z.infer<typeof exportStatusSchema>;

export const exportSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  status: exportStatusSchema,
  manifestKey: z.string().nullable(),
});
export type Export = z.infer<typeof exportSchema>;

export const webhookEventSchema = z.object({
  id: z.string(),
  provider: z.string(),
  eventId: z.string(),
  payloadHash: z.string(),
  processedAt: z.coerce.date().nullable(),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/**
 * Job progress event contract (section 7). Consumers must tolerate
 * duplicate events and out-of-order delivery; this schema is the wire
 * format for SSE/WebSocket progress updates.
 */
export const jobEventSchema = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  stage: z.string(),
  status: jobStatusSchema,
  progress: z.number().min(0).max(1),
  messageCode: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  occurredAt: z.coerce.date(),
});
export type JobEvent = z.infer<typeof jobEventSchema>;

/**
 * Supported first-class languages for insight extraction and the
 * editorial brief (section 6.4: Arabic is treated as a first-class
 * language, not a translation target of English output).
 */
export const supportedLanguageSchema = z.enum(['ar', 'en']);
export type SupportedLanguage = z.infer<typeof supportedLanguageSchema>;

// An evidence array is a list of TranscriptSegment IDs. Every
// evidence-bearing field must resolve to real segments in the same
// project's transcript — structurally required here (min 1, so
// nothing is asserted with zero support), and checked for real
// existence in lib/insights/validate.ts.
const evidenceSchema = z.array(z.string()).min(1);

const groundedTextSchema = z.object({
  text: z.string().min(1),
  evidence: evidenceSchema,
});

export const editorialThemeSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  summary: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialTheme = z.infer<typeof editorialThemeSchema>;

export const editorialKeyPointSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialKeyPoint = z.infer<typeof editorialKeyPointSchema>;

export const editorialQuoteSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialQuote = z.infer<typeof editorialQuoteSchema>;

export const editorialHookSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialHook = z.infer<typeof editorialHookSchema>;

export const editorialCandidateClipSchema = z.object({
  id: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  rationale: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialCandidateClip = z.infer<typeof editorialCandidateClipSchema>;

// Claims requiring cautious wording (section 6.4.2): the brief must
// distinguish what the speaker explicitly said from what the system
// inferred, and never present inference as fact — `qualification`
// carries that caveat forward into any downstream draft.
export const editorialClaimSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  qualification: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialClaim = z.infer<typeof editorialClaimSchema>;

export const editorialCallToActionSchema = z.object({
  text: z.string().min(1),
  evidence: evidenceSchema,
});
export type EditorialCallToAction = z.infer<typeof editorialCallToActionSchema>;

export const evidenceMapEntrySchema = z.object({
  segmentIds: z.array(z.string()).min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
});
export type EvidenceMapEntry = z.infer<typeof evidenceMapEntrySchema>;

/**
 * The canonical Editorial Brief (section 6.4.2): the source-grounded
 * compiled document every downstream asset (shorts, social posts,
 * blog, ...) is generated from. Every evidence array must reference
 * real TranscriptSegment IDs from the same project's transcript —
 * lib/insights/validate.ts performs that existence check, which this
 * schema alone can't express structurally.
 */
export const editorialBriefSchema = z.object({
  thesis: groundedTextSchema,
  audience: z.string(),
  language: supportedLanguageSchema,
  themes: z.array(editorialThemeSchema),
  keyPoints: z.array(editorialKeyPointSchema),
  quotes: z.array(editorialQuoteSchema),
  hooks: z.array(editorialHookSchema),
  candidateClips: z.array(editorialCandidateClipSchema),
  claims: z.array(editorialClaimSchema),
  callToAction: editorialCallToActionSchema.nullable(),
  evidenceMap: z.record(z.string(), evidenceMapEntrySchema),
  confidenceNotes: z.string(),
});
export type EditorialBrief = z.infer<typeof editorialBriefSchema>;

// What a provider is expected to return: everything except
// evidenceMap, which the orchestrator derives itself from the real
// TranscriptSegment rows the referenced evidence IDs resolve to. This
// keeps evidenceMap's timestamps/text trustworthy regardless of what a
// provider claims, and keeps providers from having to plumb segment
// lookups through just to echo them back.
export const editorialBriefDraftSchema = editorialBriefSchema.omit({ evidenceMap: true });
export type EditorialBriefDraft = z.infer<typeof editorialBriefDraftSchema>;

// --- Step 7: content generation (Editorial Brief -> blog/social) ---

export const socialPlatformSchema = z.enum(['x', 'linkedin', 'instagram']);
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

export const generationArtifactTypeSchema = z.enum(['blog_draft', 'social_post', 'caption']);
export type GenerationArtifactType = z.infer<typeof generationArtifactTypeSchema>;

/**
 * Generation settings (section 6: basic settings now — tone, audience,
 * language, dialect, platform). A future brand_voice/creator_style
 * "Content DNA" config can be layered on top of this same request
 * shape later without a breaking change; it is deliberately not built
 * here.
 */
export const generationSettingsSchema = z.object({
  tone: z.string().min(1),
  audience: z.string(),
  language: supportedLanguageSchema,
  dialect: z.string().optional(),
  platform: socialPlatformSchema.nullable(),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

// Evidence here is a list of Insight IDs (not transcript segment IDs
// directly — those are reachable through the Insight's own
// segmentIds/startMs/endMs, resolved into groundingMap by the
// orchestrator, same pattern as editorialBrief.evidenceMap).
const insightEvidenceSchema = z.array(z.string()).min(1);

// A claim the model considered but could not ground in the Editorial
// Brief's evidence — flagged instead of silently invented or dropped.
export const unsupportedClaimSchema = z.object({
  text: z.string().min(1),
  note: z.string().min(1),
});
export type UnsupportedClaim = z.infer<typeof unsupportedClaimSchema>;

export const blogSectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  evidence: insightEvidenceSchema,
});
export type BlogSection = z.infer<typeof blogSectionSchema>;

/** What a blog-generation provider returns (before grounding enrichment). */
export const blogDraftDataSchema = z.object({
  title: z.string().min(1),
  introduction: z.string().min(1),
  sections: z.array(blogSectionSchema).min(1),
  conclusion: z.string().min(1),
  callToAction: z.object({ text: z.string().min(1), evidence: insightEvidenceSchema }).nullable(),
  unsupportedClaims: z.array(unsupportedClaimSchema).default([]),
});
export type BlogDraftData = z.infer<typeof blogDraftDataSchema>;

/** What a social/caption-generation provider returns, for any platform. */
export const socialDraftDataSchema = z.object({
  title: z.string().min(1),
  hook: z.string().min(1),
  body: z.string().min(1),
  callToAction: z.string().nullable(),
  hashtags: z.array(z.string()),
  evidence: insightEvidenceSchema,
  unsupportedClaims: z.array(unsupportedClaimSchema).default([]),
});
export type SocialDraftData = z.infer<typeof socialDraftDataSchema>;

export const groundingRefSchema = z.object({
  insightType: insightTypeSchema,
  text: z.string(),
  segmentIds: z.array(z.string()),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type GroundingRef = z.infer<typeof groundingRefSchema>;

/**
 * The full persisted ArtifactVersion.body for a generated content
 * artifact: the draft content plus the settings it was generated with
 * and a groundingMap resolving every referenced Insight ID to its
 * real source. Mirrors editorialBrief.evidenceMap (step 6), keyed by
 * Insight ID instead of transcript segment ID, and built by the
 * orchestrator from real Insight rows — never from the provider.
 */
export const blogArtifactBodySchema = z.object({
  kind: z.literal('blog_draft'),
  data: blogDraftDataSchema,
  settings: generationSettingsSchema,
  groundingMap: z.record(z.string(), groundingRefSchema),
});
export type BlogArtifactBody = z.infer<typeof blogArtifactBodySchema>;

export const socialArtifactBodySchema = z.object({
  kind: z.enum(['social_post', 'caption']),
  data: socialDraftDataSchema,
  settings: generationSettingsSchema,
  groundingMap: z.record(z.string(), groundingRefSchema),
});
export type SocialArtifactBody = z.infer<typeof socialArtifactBodySchema>;

// --- Step 8: short-video rendering (CandidateClip -> FFmpeg -> 9:16 MP4) ---

/**
 * The one deterministic render configuration for MVP (section 3/4 of
 * the Step 8 spec): no template system, no user-selectable options.
 * `templateVersion` documents which version of the rendering strategy
 * produced a given render, since the strategy may evolve later even
 * though it is never a per-request choice.
 */
export const renderConfigSchema = z.object({
  templateVersion: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  framingStrategy: z.literal('scale-and-center-crop'),
  videoCodec: z.string(),
  audioCodec: z.string().nullable(),
  container: z.literal('mp4'),
  captionStyle: z.string(),
});
export type RenderConfig = z.infer<typeof renderConfigSchema>;

/**
 * Real, measured output metadata from ffprobe — never assumed. Used
 * both for the persisted artifact body and for the render_minutes
 * usage charge (section 8/14: "the render duration charged must
 * correspond to the actual rendered clip duration").
 */
export const renderOutputMetadataSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoCodec: z.string(),
  audioCodec: z.string().nullable(),
  hasAudio: z.boolean(),
  fileSizeBytes: z.number().int().nonnegative(),
});
export type RenderOutputMetadata = z.infer<typeof renderOutputMetadataSchema>;

/**
 * What a rendered short_video ContentArtifact's ArtifactVersion.body
 * holds. Source-grounded like every other generated artifact:
 * candidateClipId + sourceBriefVersionId trace back to the exact
 * pinned Editorial Brief version and clip that produced this render,
 * and evidence lists the real transcript segment IDs the clip and its
 * burned-in captions were built from.
 */
export const shortVideoArtifactBodySchema = z.object({
  kind: z.literal('short_video'),
  title: z.string(),
  candidateClipId: z.string(),
  sourceBriefVersionId: z.string(),
  renderJobId: z.string(),
  mediaFileId: z.string(),
  language: supportedLanguageSchema,
  config: renderConfigSchema,
  output: renderOutputMetadataSchema,
  hasCaptions: z.boolean(),
  // True when the source's native resolution was smaller than the
  // 1080x1920 target on either axis, so scale-and-crop had to upscale
  // rather than downscale (section 3: "If the source resolution is
  // insufficient, handle it gracefully rather than pretending quality
  // is unchanged") — the render still succeeds, but this is recorded
  // rather than silently hidden.
  sourceUpscaled: z.boolean(),
  evidence: z.array(z.string()).min(1),
  clipRationale: z.string(),
  performance: z.object({
    sourceDurationMs: z.number().int().nonnegative(),
    renderDurationMs: z.number().int().nonnegative(),
    processingRatio: z.number().nonnegative(),
  }),
});
export type ShortVideoArtifactBody = z.infer<typeof shortVideoArtifactBodySchema>;

export const startRenderRequestSchema = z.object({
  candidateClipId: z.string().min(1),
});
export type StartRenderRequest = z.infer<typeof startRenderRequestSchema>;
