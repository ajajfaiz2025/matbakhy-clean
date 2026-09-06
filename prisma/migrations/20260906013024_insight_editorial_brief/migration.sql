/*
  Warnings:

  - Added the required column `text` to the `insights` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "ArtifactType" ADD VALUE 'editorial_brief';

-- AlterEnum
ALTER TYPE "InsightType" ADD VALUE 'key_point';

-- AlterTable
ALTER TABLE "insights" ADD COLUMN     "segment_ids" TEXT[],
ADD COLUMN     "text" TEXT NOT NULL,
ALTER COLUMN "score" DROP NOT NULL,
ALTER COLUMN "rationale" DROP NOT NULL;
