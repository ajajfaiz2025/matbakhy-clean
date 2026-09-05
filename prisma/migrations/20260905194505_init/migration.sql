-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('active', 'invited', 'suspended');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('draft', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "MediaFileKind" AS ENUM ('source', 'proxy', 'rendered');

-- CreateEnum
CREATE TYPE "MediaFileStatus" AS ENUM ('uploading', 'uploaded', 'validating', 'normalized', 'failed');

-- CreateEnum
CREATE TYPE "InsightType" AS ENUM ('theme', 'quote', 'hook', 'clip_candidate', 'chapter', 'call_to_action', 'claim');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('blog_post', 'social_caption', 'title', 'summary', 'chapter_list', 'short_video', 'quote_card', 'metadata');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('draft', 'generating', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'retrying', 'dead_letter');

-- CreateEnum
CREATE TYPE "PipelineJobType" AS ENUM ('normalization', 'transcription', 'analysis');

-- CreateEnum
CREATE TYPE "UsageEventType" AS ENUM ('transcription_minutes', 'generation_call', 'render_minutes', 'export_bytes', 'storage_bytes');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'draft',
    "source_media_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "MediaFileKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "checksum" TEXT,
    "status" "MediaFileStatus" NOT NULL DEFAULT 'uploading',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT,
    "media_file_id" TEXT,
    "type" "PipelineJobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "message_code" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" TEXT NOT NULL,
    "transcript_id" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker" TEXT,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insights" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "type" "InsightType" NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_artifacts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'draft',
    "source_refs" TEXT[],
    "current_version_id" TEXT,

    CONSTRAINT "content_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_versions" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_jobs" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "output_media_id" TEXT,

    CONSTRAINT "render_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_type" "UsageEventType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'pending',
    "manifest_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_user_id_key" ON "memberships"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");

-- CreateIndex
CREATE INDEX "media_files_workspace_id_idx" ON "media_files"("workspace_id");

-- CreateIndex
CREATE INDEX "media_files_checksum_idx" ON "media_files"("checksum");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_jobs_idempotency_key_key" ON "pipeline_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "pipeline_jobs_workspace_id_idx" ON "pipeline_jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "pipeline_jobs_project_id_idx" ON "pipeline_jobs"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_project_id_key" ON "transcripts"("project_id");

-- CreateIndex
CREATE INDEX "transcript_segments_transcript_id_start_ms_idx" ON "transcript_segments"("transcript_id", "start_ms");

-- CreateIndex
CREATE INDEX "insights_project_id_type_idx" ON "insights"("project_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "content_artifacts_current_version_id_key" ON "content_artifacts"("current_version_id");

-- CreateIndex
CREATE INDEX "content_artifacts_project_id_type_idx" ON "content_artifacts"("project_id", "type");

-- CreateIndex
CREATE INDEX "artifact_versions_artifact_id_idx" ON "artifact_versions"("artifact_id");

-- CreateIndex
CREATE INDEX "render_jobs_artifact_id_idx" ON "render_jobs"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_idempotency_key_key" ON "usage_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "usage_events_workspace_id_event_type_idx" ON "usage_events"("workspace_id", "event_type");

-- CreateIndex
CREATE INDEX "exports_workspace_id_idx" ON "exports"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_media_id_fkey" FOREIGN KEY ("source_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "pipeline_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights" ADD CONSTRAINT "insights_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "artifact_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "content_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "content_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
