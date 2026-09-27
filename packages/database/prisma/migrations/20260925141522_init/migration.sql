-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('CV_PROCESSING', 'AI_PROCESSING', 'EMAIL_SENDING', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "JobPlatform" AS ENUM ('NAUKRI', 'INDEED', 'INSTAHYRE', 'LINKEDIN', 'COMPANY_CAREER_PAGE', 'GREENHOUSE', 'LEVER', 'WORKDAY', 'ASHBY', 'OTHER');

-- CreateEnum
CREATE TYPE "JobImportMethod" AS ENUM ('OFFICIAL_API', 'PARTNER_FEED', 'USER_FORWARDED_EMAIL', 'USER_INITIATED_BROWSER_IMPORT', 'MANUAL_ENTRY', 'CSV_IMPORT', 'CAREER_PAGE_URL', 'SEEDED_DEMO');

-- CreateEnum
CREATE TYPE "ApplyMethod" AS ENUM ('PLATFORM', 'CAREER_PAGE', 'EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SAVED', 'PREPARING', 'READY_FOR_REVIEW', 'APPROVED', 'OPENED_APPLY_PAGE', 'EMAIL_DRAFT_READY', 'EMAIL_SENT', 'SUBMITTED', 'INTERVIEW', 'REJECTED', 'OFFER', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SKILL_CONFIRMATION', 'EXPERIENCE_DETAIL', 'METRIC', 'SCREENING', 'PREFERENCE', 'ELIGIBILITY', 'OPEN_TEXT');

-- CreateEnum
CREATE TYPE "TruthStatus" AS ENUM ('PARSED_UNVERIFIED', 'USER_VERIFIED', 'USER_REJECTED', 'USER_EDITED');

-- CreateEnum
CREATE TYPE "WorkModePreference" AS ENUM ('remote', 'hybrid', 'onsite', 'any');

-- CreateEnum
CREATE TYPE "JobWorkMode" AS ENUM ('remote', 'hybrid', 'onsite', 'unknown');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('full_time', 'part_time', 'contract', 'internship', 'unknown');

-- CreateEnum
CREATE TYPE "SeniorityLevel" AS ENUM ('intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'unknown');

-- CreateEnum
CREATE TYPE "FactKind" AS ENUM ('CONTACT', 'SUMMARY', 'EXPERIENCE', 'EXPERIENCE_BULLET', 'PROJECT', 'SKILL', 'EDUCATION', 'CERTIFICATION', 'ACHIEVEMENT', 'QUESTIONNAIRE_ANSWER', 'OTHER');

-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('CV_PARSE', 'USER_ENTERED', 'QUESTIONNAIRE', 'DEMO_SEED');

-- CreateEnum
CREATE TYPE "SkillSource" AS ENUM ('SKILLS_SECTION', 'EXPERIENCE', 'PROJECT', 'QUESTIONNAIRE', 'USER_ADDED');

-- CreateEnum
CREATE TYPE "ResumeStatus" AS ENUM ('UPLOADED', 'PARSING', 'PARSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ResumeVersionKind" AS ENUM ('ORIGINAL', 'EDITED', 'TAILORED');

-- CreateEnum
CREATE TYPE "QuestionnaireStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PROPOSED', 'EDITED', 'APPROVED');

-- CreateEnum
CREATE TYPE "EmailDraftStatus" AS ENUM ('DRAFT', 'PREVIEWED', 'SENT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('SUCCESS', 'DUPLICATE', 'FAILED');

-- CreateEnum
CREATE TYPE "BackgroundTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "version" TEXT NOT NULL DEFAULT '2026-09',
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "yoe" DOUBLE PRECISION,
    "currentTitle" TEXT,
    "currentCompany" TEXT,
    "summary" TEXT,
    "portfolioUrl" TEXT,
    "githubUrl" TEXT,
    "linkedinUrl" TEXT,
    "resumeFormatWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "factsVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidatePreference" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "preferredLocations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workModePreference" "WorkModePreference" NOT NULL DEFAULT 'any',
    "openToRelocation" BOOLEAN NOT NULL DEFAULT false,
    "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "noticePeriod" TEXT,
    "expectedSalaryMin" INTEGER,
    "expectedSalaryMax" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidatePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resume" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "extractedTextEnc" TEXT,
    "status" "ResumeStatus" NOT NULL DEFAULT 'UPLOADED',
    "parseError" TEXT,
    "parserProvider" TEXT,
    "parserVersion" TEXT,
    "modelId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeId" TEXT,
    "parentVersionId" TEXT,
    "applicationId" TEXT,
    "kind" "ResumeVersionKind" NOT NULL,
    "label" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeParsedSection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "contentEnc" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeParsedSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TruthBankItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" "FactKind" NOT NULL,
    "text" TEXT NOT NULL,
    "originalText" TEXT,
    "status" "TruthStatus" NOT NULL DEFAULT 'PARSED_UNVERIFIED',
    "source" "FactSource" NOT NULL DEFAULT 'CV_PARSE',
    "section" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "resumeId" TEXT,
    "experienceId" TEXT,
    "projectId" TEXT,
    "educationId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TruthBankItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "status" "TruthStatus" NOT NULL DEFAULT 'PARSED_UNVERIFIED',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "degree" TEXT,
    "field" TEXT,
    "startYear" INTEGER,
    "endYear" INTEGER,
    "status" "TruthStatus" NOT NULL DEFAULT 'PARSED_UNVERIFIED',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "TruthStatus" NOT NULL DEFAULT 'PARSED_UNVERIFIED',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "related" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateSkill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "skillId" TEXT,
    "name" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "source" "SkillSource" NOT NULL DEFAULT 'SKILLS_SECTION',
    "status" "TruthStatus" NOT NULL DEFAULT 'PARSED_UNVERIFIED',
    "yearsUsed" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "platform" "JobPlatform" NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "companyWebsite" TEXT,
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workMode" "JobWorkMode" NOT NULL DEFAULT 'unknown',
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'unknown',
    "seniority" "SeniorityLevel" NOT NULL DEFAULT 'unknown',
    "description" TEXT NOT NULL,
    "responsibilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "otherRequirements" JSONB NOT NULL DEFAULT '[]',
    "screeningQuestions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experienceMinYears" DOUBLE PRECISION,
    "experienceMaxYears" DOUBLE PRECISION,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "currency" TEXT,
    "postedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "applyUrl" TEXT,
    "hrEmail" TEXT,
    "applicationInstructions" TEXT,
    "applyMethod" "ApplyMethod" NOT NULL DEFAULT 'MANUAL',
    "importMethod" "JobImportMethod" NOT NULL,
    "sourceUrl" TEXT,
    "sourceExternalId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "normalizerVersion" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSource" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "platform" "JobPlatform" NOT NULL,
    "importMethod" "JobImportMethod" NOT NULL,
    "integrationClass" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "externalId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequirement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JobRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSkillRequirement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JobSkillRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobContact" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT,

    CONSTRAINT "JobContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobImportEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "jobId" TEXT,
    "connector" TEXT NOT NULL,
    "importMethod" "JobImportMethod" NOT NULL,
    "status" "ImportStatus" NOT NULL,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobImportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAnalysis" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserJobState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserJobState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobMatchScore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "factsVersion" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobMatchScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobMatchFactor" (
    "id" TEXT NOT NULL,
    "matchScoreId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "maxPoints" DOUBLE PRECISION NOT NULL,
    "explanation" TEXT NOT NULL,

    CONSTRAINT "JobMatchFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQuestionnaire" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "QuestionnaireStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobQuestionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQuestion" (
    "id" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "text" TEXT NOT NULL,
    "whyAsked" TEXT NOT NULL,
    "requiredForJob" BOOLEAN NOT NULL DEFAULT false,
    "relatedRequirement" TEXT,
    "options" JSONB,
    "allowFreeText" BOOLEAN NOT NULL DEFAULT false,
    "showWhen" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAnswer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "freeText" TEXT,
    "truthBankItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SAVED',
    "applyMethod" "ApplyMethod" NOT NULL,
    "notes" TEXT,
    "preparationError" TEXT,
    "approvedAt" TIMESTAMP(3),
    "openedApplyPageAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "reminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus",
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TailoredResume" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "editedSummary" TEXT,
    "editedBullets" JSONB,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "status" "DraftStatus" NOT NULL DEFAULT 'PROPOSED',
    "resumeVersionId" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TailoredResume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverLetter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "originalBody" TEXT NOT NULL,
    "claims" JSONB NOT NULL DEFAULT '[]',
    "status" "DraftStatus" NOT NULL DEFAULT 'PROPOSED',
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningAnswerDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "originalAnswer" TEXT NOT NULL,
    "canConfirm" BOOLEAN NOT NULL DEFAULT false,
    "claims" JSONB NOT NULL DEFAULT '[]',
    "status" "DraftStatus" NOT NULL DEFAULT 'PROPOSED',
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningAnswerDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationEmailDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "originalBody" TEXT NOT NULL,
    "claims" JSONB NOT NULL DEFAULT '[]',
    "resumeVersionId" TEXT,
    "attachCoverLetter" BOOLEAN NOT NULL DEFAULT false,
    "status" "EmailDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "previewDigest" TEXT,
    "previewedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sendProvider" TEXT,
    "sendMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationEmailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "requestId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "status" "BackgroundTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "UserConsent_userId_idx" ON "UserConsent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserConsent_userId_type_key" ON "UserConsent"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateProfile_userId_key" ON "CandidateProfile"("userId");

-- CreateIndex
CREATE INDEX "CandidateProfile_userId_idx" ON "CandidateProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidatePreference_profileId_key" ON "CandidatePreference"("profileId");

-- CreateIndex
CREATE INDEX "CandidatePreference_userId_idx" ON "CandidatePreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Resume_storageKey_key" ON "Resume"("storageKey");

-- CreateIndex
CREATE INDEX "Resume_userId_idx" ON "Resume"("userId");

-- CreateIndex
CREATE INDEX "Resume_createdAt_idx" ON "Resume"("createdAt");

-- CreateIndex
CREATE INDEX "ResumeVersion_userId_idx" ON "ResumeVersion"("userId");

-- CreateIndex
CREATE INDEX "ResumeVersion_resumeId_idx" ON "ResumeVersion"("resumeId");

-- CreateIndex
CREATE INDEX "ResumeVersion_applicationId_idx" ON "ResumeVersion"("applicationId");

-- CreateIndex
CREATE INDEX "ResumeVersion_createdAt_idx" ON "ResumeVersion"("createdAt");

-- CreateIndex
CREATE INDEX "ResumeParsedSection_userId_idx" ON "ResumeParsedSection"("userId");

-- CreateIndex
CREATE INDEX "ResumeParsedSection_resumeId_idx" ON "ResumeParsedSection"("resumeId");

-- CreateIndex
CREATE INDEX "TruthBankItem_userId_idx" ON "TruthBankItem"("userId");

-- CreateIndex
CREATE INDEX "TruthBankItem_userId_status_idx" ON "TruthBankItem"("userId", "status");

-- CreateIndex
CREATE INDEX "TruthBankItem_profileId_idx" ON "TruthBankItem"("profileId");

-- CreateIndex
CREATE INDEX "TruthBankItem_experienceId_idx" ON "TruthBankItem"("experienceId");

-- CreateIndex
CREATE INDEX "Experience_userId_idx" ON "Experience"("userId");

-- CreateIndex
CREATE INDEX "Experience_profileId_idx" ON "Experience"("profileId");

-- CreateIndex
CREATE INDEX "Education_userId_idx" ON "Education"("userId");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "CandidateSkill_userId_idx" ON "CandidateSkill"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateSkill_profileId_canonicalName_key" ON "CandidateSkill"("profileId", "canonicalName");

-- CreateIndex
CREATE INDEX "Job_ownerUserId_idx" ON "Job"("ownerUserId");

-- CreateIndex
CREATE INDEX "Job_title_idx" ON "Job"("title");

-- CreateIndex
CREATE INDEX "Job_company_idx" ON "Job"("company");

-- CreateIndex
CREATE INDEX "Job_locations_idx" ON "Job" USING GIN ("locations");

-- CreateIndex
CREATE INDEX "Job_postedAt_idx" ON "Job"("postedAt");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "Job_platform_idx" ON "Job"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "Job_ownerUserId_dedupeKey_key" ON "Job"("ownerUserId", "dedupeKey");

-- CreateIndex
CREATE INDEX "JobSource_jobId_idx" ON "JobSource"("jobId");

-- CreateIndex
CREATE INDEX "JobRequirement_jobId_idx" ON "JobRequirement"("jobId");

-- CreateIndex
CREATE INDEX "JobSkillRequirement_jobId_idx" ON "JobSkillRequirement"("jobId");

-- CreateIndex
CREATE INDEX "JobSkillRequirement_canonicalName_idx" ON "JobSkillRequirement"("canonicalName");

-- CreateIndex
CREATE INDEX "JobContact_jobId_idx" ON "JobContact"("jobId");

-- CreateIndex
CREATE INDEX "JobImportEvent_userId_idx" ON "JobImportEvent"("userId");

-- CreateIndex
CREATE INDEX "JobImportEvent_jobId_idx" ON "JobImportEvent"("jobId");

-- CreateIndex
CREATE INDEX "JobImportEvent_createdAt_idx" ON "JobImportEvent"("createdAt");

-- CreateIndex
CREATE INDEX "JobAnalysis_jobId_idx" ON "JobAnalysis"("jobId");

-- CreateIndex
CREATE INDEX "JobAnalysis_userId_idx" ON "JobAnalysis"("userId");

-- CreateIndex
CREATE INDEX "UserJobState_userId_idx" ON "UserJobState"("userId");

-- CreateIndex
CREATE INDEX "UserJobState_jobId_idx" ON "UserJobState"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "UserJobState_userId_jobId_key" ON "UserJobState"("userId", "jobId");

-- CreateIndex
CREATE INDEX "JobMatchScore_userId_idx" ON "JobMatchScore"("userId");

-- CreateIndex
CREATE INDEX "JobMatchScore_jobId_idx" ON "JobMatchScore"("jobId");

-- CreateIndex
CREATE INDEX "JobMatchScore_userId_score_idx" ON "JobMatchScore"("userId", "score");

-- CreateIndex
CREATE INDEX "JobMatchScore_score_idx" ON "JobMatchScore"("score");

-- CreateIndex
CREATE UNIQUE INDEX "JobMatchScore_userId_jobId_key" ON "JobMatchScore"("userId", "jobId");

-- CreateIndex
CREATE INDEX "JobMatchFactor_matchScoreId_idx" ON "JobMatchFactor"("matchScoreId");

-- CreateIndex
CREATE INDEX "JobQuestionnaire_userId_idx" ON "JobQuestionnaire"("userId");

-- CreateIndex
CREATE INDEX "JobQuestionnaire_jobId_idx" ON "JobQuestionnaire"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobQuestionnaire_userId_jobId_key" ON "JobQuestionnaire"("userId", "jobId");

-- CreateIndex
CREATE INDEX "JobQuestion_questionnaireId_idx" ON "JobQuestion"("questionnaireId");

-- CreateIndex
CREATE UNIQUE INDEX "JobQuestion_questionnaireId_key_key" ON "JobQuestion"("questionnaireId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "JobAnswer_questionId_key" ON "JobAnswer"("questionId");

-- CreateIndex
CREATE INDEX "JobAnswer_userId_idx" ON "JobAnswer"("userId");

-- CreateIndex
CREATE INDEX "Application_userId_idx" ON "Application"("userId");

-- CreateIndex
CREATE INDEX "Application_jobId_idx" ON "Application"("jobId");

-- CreateIndex
CREATE INDEX "Application_status_idx" ON "Application"("status");

-- CreateIndex
CREATE INDEX "Application_userId_status_idx" ON "Application"("userId", "status");

-- CreateIndex
CREATE INDEX "Application_createdAt_idx" ON "Application"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Application_userId_jobId_key" ON "Application"("userId", "jobId");

-- CreateIndex
CREATE INDEX "ApplicationEvent_applicationId_idx" ON "ApplicationEvent"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationEvent_userId_idx" ON "ApplicationEvent"("userId");

-- CreateIndex
CREATE INDEX "ApplicationEvent_createdAt_idx" ON "ApplicationEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TailoredResume_applicationId_key" ON "TailoredResume"("applicationId");

-- CreateIndex
CREATE INDEX "TailoredResume_userId_idx" ON "TailoredResume"("userId");

-- CreateIndex
CREATE INDEX "TailoredResume_jobId_idx" ON "TailoredResume"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "CoverLetter_applicationId_key" ON "CoverLetter"("applicationId");

-- CreateIndex
CREATE INDEX "CoverLetter_userId_idx" ON "CoverLetter"("userId");

-- CreateIndex
CREATE INDEX "ScreeningAnswerDraft_userId_idx" ON "ScreeningAnswerDraft"("userId");

-- CreateIndex
CREATE INDEX "ScreeningAnswerDraft_applicationId_idx" ON "ScreeningAnswerDraft"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationEmailDraft_applicationId_key" ON "ApplicationEmailDraft"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationEmailDraft_userId_idx" ON "ApplicationEmailDraft"("userId");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionToken_tokenHash_key" ON "ExtensionToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ExtensionToken_userId_idx" ON "ExtensionToken"("userId");

-- CreateIndex
CREATE INDEX "BackgroundTask_userId_idx" ON "BackgroundTask"("userId");

-- CreateIndex
CREATE INDEX "BackgroundTask_status_runAt_idx" ON "BackgroundTask"("status", "runAt");

-- CreateIndex
CREATE INDEX "BackgroundTask_createdAt_idx" ON "BackgroundTask"("createdAt");

-- AddForeignKey
ALTER TABLE "UserConsent" ADD CONSTRAINT "UserConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateProfile" ADD CONSTRAINT "CandidateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidatePreference" ADD CONSTRAINT "CandidatePreference_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resume" ADD CONSTRAINT "Resume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "ResumeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeParsedSection" ADD CONSTRAINT "ResumeParsedSection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeParsedSection" ADD CONSTRAINT "ResumeParsedSection_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruthBankItem" ADD CONSTRAINT "TruthBankItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruthBankItem" ADD CONSTRAINT "TruthBankItem_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruthBankItem" ADD CONSTRAINT "TruthBankItem_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruthBankItem" ADD CONSTRAINT "TruthBankItem_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruthBankItem" ADD CONSTRAINT "TruthBankItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruthBankItem" ADD CONSTRAINT "TruthBankItem_educationId_fkey" FOREIGN KEY ("educationId") REFERENCES "Education"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSource" ADD CONSTRAINT "JobSource_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSkillRequirement" ADD CONSTRAINT "JobSkillRequirement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobImportEvent" ADD CONSTRAINT "JobImportEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobImportEvent" ADD CONSTRAINT "JobImportEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAnalysis" ADD CONSTRAINT "JobAnalysis_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAnalysis" ADD CONSTRAINT "JobAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobState" ADD CONSTRAINT "UserJobState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobState" ADD CONSTRAINT "UserJobState_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMatchScore" ADD CONSTRAINT "JobMatchScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMatchScore" ADD CONSTRAINT "JobMatchScore_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMatchFactor" ADD CONSTRAINT "JobMatchFactor_matchScoreId_fkey" FOREIGN KEY ("matchScoreId") REFERENCES "JobMatchScore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQuestionnaire" ADD CONSTRAINT "JobQuestionnaire_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQuestionnaire" ADD CONSTRAINT "JobQuestionnaire_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQuestion" ADD CONSTRAINT "JobQuestion_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "JobQuestionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAnswer" ADD CONSTRAINT "JobAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAnswer" ADD CONSTRAINT "JobAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "JobQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAnswer" ADD CONSTRAINT "JobAnswer_truthBankItemId_fkey" FOREIGN KEY ("truthBankItemId") REFERENCES "TruthBankItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TailoredResume" ADD CONSTRAINT "TailoredResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TailoredResume" ADD CONSTRAINT "TailoredResume_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverLetter" ADD CONSTRAINT "CoverLetter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverLetter" ADD CONSTRAINT "CoverLetter_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAnswerDraft" ADD CONSTRAINT "ScreeningAnswerDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAnswerDraft" ADD CONSTRAINT "ScreeningAnswerDraft_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEmailDraft" ADD CONSTRAINT "ApplicationEmailDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEmailDraft" ADD CONSTRAINT "ApplicationEmailDraft_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionToken" ADD CONSTRAINT "ExtensionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundTask" ADD CONSTRAINT "BackgroundTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
