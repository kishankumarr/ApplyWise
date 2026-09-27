-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "runtimeQuestions" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "AutomationSettings" ADD COLUMN     "runLeaseRunId" TEXT;

