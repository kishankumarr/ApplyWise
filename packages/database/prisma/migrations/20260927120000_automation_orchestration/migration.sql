-- CreateEnum
CREATE TYPE "ApplicationMode" AS ENUM ('MANUAL', 'REVIEW', 'AUTO');

-- CreateEnum
CREATE TYPE "AutomationDecision" AS ENUM ('IGNORE', 'RECOMMEND', 'REVIEW', 'AUTO_ELIGIBLE');

-- CreateEnum
CREATE TYPE "ManualActionReason" AS ENUM ('CAPTCHA', 'MFA', 'LOGIN_REQUIRED', 'UNSUPPORTED_FLOW', 'UNKNOWN_REQUIRED_QUESTION', 'PROVIDER_RESTRICTION', 'AUTOMATION_NOT_SUPPORTED', 'SUBMISSION_UNCERTAIN');

-- CreateEnum
CREATE TYPE "ApplicationOrigin" AS ENUM ('USER', 'AUTOMATION');

-- CreateEnum
CREATE TYPE "ExecutorKind" AS ENUM ('API', 'BROWSER', 'MANUAL');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'MANUAL_ACTION_REQUIRED', 'NEEDS_INFORMATION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProviderConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_AUTHENTICATION', 'NEEDS_ATTENTION', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ProviderAuthType" AS ENUM ('NONE', 'API_KEY', 'OAUTH_TOKEN', 'SESSION_TOKEN');

-- CreateEnum
CREATE TYPE "AnswerSource" AS ENUM ('PROFILE', 'PREFERENCE', 'TRUTH_BANK', 'PREVIOUS_ANSWER', 'CANDIDATE_ANSWER', 'GENERATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ApplicationMessageCategory" AS ENUM ('APPLICATION_CONFIRMATION', 'RECRUITER_RESPONSE', 'ASSESSMENT', 'INTERVIEW', 'REJECTION', 'OFFER', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApplicationStatus" ADD VALUE 'DISCOVERED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'MATCHING';
ALTER TYPE "ApplicationStatus" ADD VALUE 'MATCHED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'REJECTED_BY_RULES';
ALTER TYPE "ApplicationStatus" ADD VALUE 'NEEDS_INFORMATION';
ALTER TYPE "ApplicationStatus" ADD VALUE 'WAITING_APPROVAL';
ALTER TYPE "ApplicationStatus" ADD VALUE 'AUTO_ELIGIBLE';
ALTER TYPE "ApplicationStatus" ADD VALUE 'APPLYING';
ALTER TYPE "ApplicationStatus" ADD VALUE 'APPLIED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'FAILED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'MANUAL_ACTION_REQUIRED';
ALTER TYPE "ApplicationStatus" ADD VALUE 'ASSESSMENT';

-- AlterEnum
ALTER TYPE "ConsentType" ADD VALUE 'AUTO_APPLY';

-- AlterEnum
ALTER TYPE "JobFeedKind" ADD VALUE 'DEMO';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "approvalSource" TEXT,
ADD COLUMN     "automationDecision" "AutomationDecision",
ADD COLUMN     "automationRunId" TEXT,
ADD COLUMN     "canonicalJobKey" TEXT,
ADD COLUMN     "decisionReasons" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "decisionScore" INTEGER,
ADD COLUMN     "evaluatedAt" TIMESTAMP(3),
ADD COLUMN     "executorId" TEXT,
ADD COLUMN     "executorKind" "ExecutorKind",
ADD COLUMN     "externalApplicationId" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "lastStatusSyncAt" TIMESTAMP(3),
ADD COLUMN     "manualActionDetail" TEXT,
ADD COLUMN     "manualActionReason" "ManualActionReason",
ADD COLUMN     "mode" "ApplicationMode",
ADD COLUMN     "nextActionAt" TIMESTAMP(3),
ADD COLUMN     "origin" "ApplicationOrigin" NOT NULL DEFAULT 'USER',
ADD COLUMN     "pendingQuestions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "preparedAt" TIMESTAMP(3),
ADD COLUMN     "resumeSelectionOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resumeSelectionReason" TEXT,
ADD COLUMN     "resumeSelectionScore" DOUBLE PRECISION,
ADD COLUMN     "rulesVersion" INTEGER,
ADD COLUMN     "selectedResumeId" TEXT,
ADD COLUMN     "selectedResumeVersionId" TEXT,
ADD COLUMN     "skippedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ApplicationEvent" ADD COLUMN     "actor" TEXT NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "Resume" ADD COLUMN     "label" TEXT,
ADD COLUMN     "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ScreeningAnswerDraft" ADD COLUMN     "answerSource" "AnswerSource" NOT NULL DEFAULT 'GENERATED',
ADD COLUMN     "questionKey" TEXT,
ADD COLUMN     "required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resolved" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "ApplicationMode" NOT NULL DEFAULT 'MANUAL',
    "recommendScore" INTEGER NOT NULL DEFAULT 50,
    "minMatchScore" INTEGER NOT NULL DEFAULT 70,
    "autoApplyScore" INTEGER NOT NULL DEFAULT 90,
    "maxApplicationsPerDay" INTEGER NOT NULL DEFAULT 10,
    "maxJobAgeDays" INTEGER NOT NULL DEFAULT 14,
    "searchFrequencyMinutes" INTEGER NOT NULL DEFAULT 360,
    "enabledProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quietHoursStart" INTEGER,
    "quietHoursEnd" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "tailorResume" BOOLEAN NOT NULL DEFAULT true,
    "generateCoverLetter" BOOLEAN NOT NULL DEFAULT true,
    "allowEmailApplications" BOOLEAN NOT NULL DEFAULT false,
    "notifyStrongMatches" BOOLEAN NOT NULL DEFAULT true,
    "dailySummaryHour" INTEGER DEFAULT 20,
    "rulesVersion" INTEGER NOT NULL DEFAULT 1,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "runLeaseUntil" TIMESTAMP(3),
    "lastDailySummaryDay" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredSkillsMode" TEXT NOT NULL DEFAULT 'any',
    "allowMissingMandatorySkills" BOOLEAN NOT NULL DEFAULT false,
    "maxExperienceGapYears" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "locationMode" TEXT NOT NULL DEFAULT 'preferences',
    "allowedWorkModes" "JobWorkMode"[] DEFAULT ARRAY[]::"JobWorkMode"[],
    "minSalary" INTEGER,
    "salaryCurrency" TEXT NOT NULL DEFAULT 'INR',
    "allowedApplyMethods" "ApplyMethod"[] DEFAULT ARRAY[]::"ApplyMethod"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "mode" "ApplicationMode" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "providersChecked" INTEGER NOT NULL DEFAULT 0,
    "jobsFound" INTEGER NOT NULL DEFAULT 0,
    "newJobs" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "jobsMatched" INTEGER NOT NULL DEFAULT 0,
    "ignored" INTEGER NOT NULL DEFAULT 0,
    "recommended" INTEGER NOT NULL DEFAULT 0,
    "reviewRequired" INTEGER NOT NULL DEFAULT 0,
    "autoEligible" INTEGER NOT NULL DEFAULT 0,
    "applicationsPrepared" INTEGER NOT NULL DEFAULT 0,
    "applicationsSubmitted" INTEGER NOT NULL DEFAULT 0,
    "needsInformation" INTEGER NOT NULL DEFAULT 0,
    "manualActions" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRunItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "applicationId" TEXT,
    "stage" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationExecution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "executorKind" "ExecutorKind" NOT NULL,
    "executorId" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "slotDay" TEXT,
    "externalApplicationId" TEXT,
    "confirmation" TEXT,
    "manualActionReason" "ManualActionReason",
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyApplicationCounter" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyApplicationCounter_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "authType" "ProviderAuthType" NOT NULL,
    "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "accountLabel" TEXT,
    "secretEnc" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateAnswer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "source" "AnswerSource" NOT NULL DEFAULT 'CANDIDATE_ANSWER',
    "status" "TruthStatus" NOT NULL DEFAULT 'USER_VERIFIED',
    "truthBankItemId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "category" "ApplicationMessageCategory" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "messageHash" TEXT NOT NULL,
    "fromDomain" TEXT,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "associatedBy" TEXT,
    "statusApplied" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomationSettings_userId_key" ON "AutomationSettings"("userId");

-- CreateIndex
CREATE INDEX "AutomationSettings_enabled_nextRunAt_idx" ON "AutomationSettings"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_userId_key" ON "AutomationRule"("userId");

-- CreateIndex
CREATE INDEX "AutomationRun_userId_startedAt_idx" ON "AutomationRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "AutomationRun_status_idx" ON "AutomationRun"("status");

-- CreateIndex
CREATE INDEX "AutomationRunItem_runId_createdAt_idx" ON "AutomationRunItem"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationRunItem_applicationId_idx" ON "AutomationRunItem"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationExecution_idempotencyKey_key" ON "ApplicationExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ApplicationExecution_applicationId_idx" ON "ApplicationExecution"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationExecution_userId_status_idx" ON "ApplicationExecution"("userId", "status");

-- CreateIndex
CREATE INDEX "ApplicationExecution_status_leaseUntil_idx" ON "ApplicationExecution"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "ProviderConnection_status_idx" ON "ProviderConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_userId_provider_key" ON "ProviderConnection"("userId", "provider");

-- CreateIndex
CREATE INDEX "CandidateAnswer_userId_idx" ON "CandidateAnswer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAnswer_userId_questionKey_key" ON "CandidateAnswer"("userId", "questionKey");

-- CreateIndex
CREATE INDEX "ApplicationMessage_applicationId_idx" ON "ApplicationMessage"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationMessage_userId_receivedAt_idx" ON "ApplicationMessage"("userId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationMessage_userId_messageHash_key" ON "ApplicationMessage"("userId", "messageHash");

-- CreateIndex
CREATE INDEX "Application_userId_canonicalJobKey_idx" ON "Application"("userId", "canonicalJobKey");

-- CreateIndex
CREATE INDEX "Application_userId_automationDecision_idx" ON "Application"("userId", "automationDecision");

-- CreateIndex
CREATE INDEX "Application_automationRunId_idx" ON "Application"("automationRunId");

-- CreateIndex
CREATE INDEX "Application_status_nextActionAt_idx" ON "Application"("status", "nextActionAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_automationRunId_fkey" FOREIGN KEY ("automationRunId") REFERENCES "AutomationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_selectedResumeId_fkey" FOREIGN KEY ("selectedResumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunItem" ADD CONSTRAINT "AutomationRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationExecution" ADD CONSTRAINT "ApplicationExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationExecution" ADD CONSTRAINT "ApplicationExecution_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyApplicationCounter" ADD CONSTRAINT "DailyApplicationCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAnswer" ADD CONSTRAINT "CandidateAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAnswer" ADD CONSTRAINT "CandidateAnswer_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationMessage" ADD CONSTRAINT "ApplicationMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationMessage" ADD CONSTRAINT "ApplicationMessage_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

