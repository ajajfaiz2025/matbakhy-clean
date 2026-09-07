-- AlterEnum
ALTER TYPE "PipelineJobType" ADD VALUE 'render';

-- AlterTable
ALTER TABLE "render_jobs" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "candidate_clip_id" TEXT NOT NULL,
ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "idempotency_key" TEXT NOT NULL,
ADD COLUMN     "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "project_id" TEXT NOT NULL,
ADD COLUMN     "source_brief_version_id" TEXT NOT NULL,
ADD COLUMN     "source_media_id" TEXT NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "workspace_id" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "render_jobs_idempotency_key_key" ON "render_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "render_jobs_workspace_id_idx" ON "render_jobs"("workspace_id");

-- AddForeignKey
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

