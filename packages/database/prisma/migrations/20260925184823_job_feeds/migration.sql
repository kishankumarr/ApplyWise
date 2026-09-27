-- CreateEnum
CREATE TYPE "JobDescriptionLevel" AS ENUM ('FULL', 'SNIPPET');

-- CreateEnum
CREATE TYPE "JobFeedKind" AS ENUM ('SEARCH', 'COMPANY_BOARD', 'MAILBOX');

-- CreateEnum
CREATE TYPE "JobFeedStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR', 'NEEDS_ATTENTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobImportMethod" ADD VALUE 'JOB_SEARCH_API';
ALTER TYPE "JobImportMethod" ADD VALUE 'USER_MAILBOX_ALERT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobPlatform" ADD VALUE 'SMARTRECRUITERS';
ALTER TYPE "JobPlatform" ADD VALUE 'WORKABLE';
ALTER TYPE "JobPlatform" ADD VALUE 'RECRUITEE';
ALTER TYPE "JobPlatform" ADD VALUE 'FOUNDIT';
ALTER TYPE "JobPlatform" ADD VALUE 'GLASSDOOR';
ALTER TYPE "JobPlatform" ADD VALUE 'WELLFOUND';
ALTER TYPE "JobPlatform" ADD VALUE 'CUTSHORT';
ALTER TYPE "JobPlatform" ADD VALUE 'HIRIST';
ALTER TYPE "JobPlatform" ADD VALUE 'JOB_SEARCH_API';

-- AlterTable
ALTER TABLE "CandidatePreference" ADD COLUMN     "jobsSeenAt" TIMESTAMP(3),
ADD COLUMN     "showDemoJobs" BOOLEAN;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "descriptionLevel" "JobDescriptionLevel" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "feedId" TEXT,
ADD COLUMN     "matchKey" TEXT;

-- CreateTable
CREATE TABLE "JobFeed" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "JobFeedKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretEnc" TEXT,
    "status" "JobFeedStatus" NOT NULL DEFAULT 'ACTIVE',
    "intervalMinutes" INTEGER NOT NULL DEFAULT 360,
    "lastSyncAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastResult" JSONB NOT NULL DEFAULT '{}',
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobFeedRun" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "merged" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "JobFeedRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobFeed_userId_idx" ON "JobFeed"("userId");

-- CreateIndex
CREATE INDEX "JobFeed_status_nextSyncAt_idx" ON "JobFeed"("status", "nextSyncAt");

-- CreateIndex
CREATE INDEX "JobFeedRun_feedId_startedAt_idx" ON "JobFeedRun"("feedId", "startedAt");

-- CreateIndex
CREATE INDEX "JobFeedRun_userId_idx" ON "JobFeedRun"("userId");

-- CreateIndex
CREATE INDEX "Job_ownerUserId_matchKey_idx" ON "Job"("ownerUserId", "matchKey");

-- CreateIndex
CREATE INDEX "Job_feedId_idx" ON "Job"("feedId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "JobFeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFeed" ADD CONSTRAINT "JobFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFeedRun" ADD CONSTRAINT "JobFeedRun_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "JobFeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFeedRun" ADD CONSTRAINT "JobFeedRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
