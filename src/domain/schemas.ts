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
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  rationale: z.string(),
});
export type Insight = z.infer<typeof insightSchema>;

export const artifactTypeSchema = z.enum([
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
  artifactId: z.string(),
  template: z.string(),
  status: jobStatusSchema,
  outputMediaId: z.string().nullable(),
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
