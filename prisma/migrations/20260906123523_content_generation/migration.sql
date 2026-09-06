/*
  Warnings:

  - Added the required column `language` to the `content_artifacts` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('x', 'linkedin', 'instagram');

-- CreateEnum
CREATE TYPE "ArtifactTier" AS ENUM ('preview', 'paid');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ArtifactType" ADD VALUE 'blog_draft';
ALTER TYPE "ArtifactType" ADD VALUE 'social_post';
ALTER TYPE "ArtifactType" ADD VALUE 'caption';

-- AlterEnum
ALTER TYPE "PipelineJobType" ADD VALUE 'generation';

-- DropIndex
DROP INDEX "content_artifacts_project_id_type_idx";

-- AlterTable
ALTER TABLE "artifact_versions" ADD COLUMN     "source_brief_version_id" TEXT,
ADD COLUMN     "tier" "ArtifactTier" NOT NULL DEFAULT 'preview';

-- AlterTable
ALTER TABLE "content_artifacts" ADD COLUMN     "language" TEXT NOT NULL,
ADD COLUMN     "platform" "SocialPlatform";

-- CreateIndex
CREATE INDEX "content_artifacts_project_id_type_platform_language_idx" ON "content_artifacts"("project_id", "type", "platform", "language");

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_source_brief_version_id_fkey" FOREIGN KEY ("source_brief_version_id") REFERENCES "artifact_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
