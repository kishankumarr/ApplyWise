# Automation gap analysis

This document compares the **pre-automation ApplyWise codebase** (the baseline) with the target "Fully Automated Job
Discovery, Matching and Application Orchestration Platform" and records, requirement by requirement, what already
existed, what is extended or refactored, what is new, and what cannot be delivered because of external limitations.

- **Baseline**: the snapshot of the repository taken before the automation work started (440 files; extracted and
  analysed read-only). Evidence paths are relative to the repository root and refer to that snapshot; the same paths
  exist in the current tree unless the decision says otherwise.
- **Decided design**: [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md), the shared contracts in
  `packages/types/src/automation.ts`, and the migration `packages/database/prisma/migrations/20260927120000_automation_orchestration`.
  The "Decision" column names the module chosen there.
- **Scope**: sections 1-9 are a classification of the baseline, not a progress tracker. When they were written
  (2026-09-27) several of the chosen modules were contract stubs being implemented in parallel (see
  [Verification](#9-verification)). What was actually delivered, and what remains, is recorded afterwards in
  [section 10, Implementation status](#10-implementation-status); the analysis above it is kept as written.

| Class | Meaning |
| --- | --- |
| **EXISTS** | The baseline already meets the requirement; it is reused unchanged (it may gain new callers). |
| **EXTEND** | The baseline has the right module/model; new fields, states, callers or options are added to it. |
| **REFACTOR** | The baseline has the capability, but its behaviour or contract must change (e.g. to become race-free or to stop producing placeholders). |
| **NEW** | Nothing comparable existed; a new module/model is added in the location named in the decision. |
| **EXTERNAL_LIMITATION** | Cannot be delivered honestly: the provider's terms or technical barriers (no public API, login walls, anti-automation terms) prevent it. |
| REQUIRES_EXTERNAL_CONFIGURATION | Used in the source table (section 2.9): technically possible, but only with an agreement or credential ApplyWise does not have (partner API, employer API key). |

---

## 1. Executive summary

### 1.1 What the baseline already did well (must be preserved)

1. **Truth model.** Every parsed item starts `PARSED_UNVERIFIED`; only `USER_VERIFIED` / `USER_EDITED` facts (and
   user-entered profile fields exposed as `profile:yoe`, `profile:title`, `profile:notice`) are evidence
   (`verifiedSourceFacts` in `packages/database/src/candidate.ts`). This is exactly the "verified facts only" rule the
   automation needs; it is reused, not re-implemented.
2. **Deterministic matching with explanations.** `computeMatchReport` (`packages/job-engine/src/matching.ts`,
   `MATCH_ENGINE_VERSION = "match-v1.3"`) produces the score and per-factor explanations stored in `JobMatchScore` /
   `JobMatchFactor`. The score is never produced by AI. The rule engine consumes this report; it never recomputes a score.
3. **AI safety layer.** All AI calls live in `packages/ai` with deterministic fallbacks, versioned prompts, and the
   deterministic claim validator (`packages/ai/src/guards/claim-validator.ts`) that rejects unsupported numbers,
   technologies, employers and credentials.
4. **Automatic job intake.** `JobFeed` / `JobFeedRun` with atomic claims and a 10-minute lease (`LEASE_MS` in
   `apps/web/src/server/services/job-feeds.service.ts`), exponential backoff, `NEEDS_ATTENTION` on authentication
   failures (no silent retries), per-provider quotas (`FeedProviderUsage`), and read-only mailbox access limited to known
   job-alert senders (`packages/mail-sources`).
5. **Cross-source de-duplication.** `persistNormalizedJob` (`packages/database/src/jobs.ts`) merges the same role found
   via several sources by `matchKey` (title + company + primary city, 60-day window), attaches each `JobSource` once and
   upgrades snippet-only descriptions.
6. **One queue abstraction** (`apps/web/src/server/queue`: inline / memory / BullMQ drivers, `BackgroundTask` tracking,
   separate `feeds` lane).
7. **Security baseline.** Ownership by `userId` in every query (`server/repositories/ownership.ts`, 404 on foreign
   resources), AES-256-GCM encryption (`server/crypto.ts`, `server/storage.ts`), PII-redacting logger
   (`server/logger.ts`), audit log (`server/audit.ts`), same-origin check for mutating API calls (`middleware.ts`), rate
   limiting (`server/rate-limit.ts`), cascade deletion and data export (`account.service.ts`).
8. **Email send guard.** `sendConfirmedEmail` (`packages/email/src/confirmation.ts`) is the only send path; it requires an
   HMAC confirmation token bound to a SHA-256 digest of the exact message, plus consent and a verified address.
9. **Extension guardrails.** MV3 popup only, no content scripts, user-triggered import with preview, prefill of selected
   fields only, and an ESLint rule (`apps/extension/eslint.config.js`) that forbids `.submit()`, `.requestSubmit()` and
   `.click()` in the extension.
10. **Tests.** Unit suites for every package, DB-backed integration tests for ownership, flows, feeds and security
    (`apps/web/test/*.test.ts`), and nine Playwright specs including `07-no-auto-submit.spec.ts`.

### 1.2 Biggest gaps

1. **No automation concept at all**: no application mode, no user settings/rules, no decision (IGNORE / RECOMMEND /
   REVIEW / AUTO_ELIGIBLE), no orchestrator and no run history. The baseline's `applicationRecommendation`
   (`apply` / `apply_with_caution` / `do_not_prioritize`) is informational only.
2. **No submission path** (by design): no executor abstraction, no idempotency key, no daily limit, no execution lease
   or crash recovery, no worker process separate from the web server.
3. **The state machine covers only the manual flow** (13 states), and transitions are read-then-write, not
   compare-and-set (`transition()` in `application.service.ts`), so two workers could both move the same application.
4. **Unknown answers are placeholders, not a blocking state**: `fallbackScreeningAnswer` returns "I cannot confirm this
   from my verified profile yet. [Please answer this question yourself before submitting.]" with `canConfirm: false`.
   There is no reusable, cross-job answer store for questions such as notice period, work authorisation or visa.
5. **One resume in practice**: several `Resume` rows can exist, but tailoring always starts from the verified profile
   (`documentFromProfile`), there is no per-application resume choice except the email attachment.
6. **No provider/capability model**: search adapters, board adapters, alert parsers and connectors each have their own
   interface; source limitations are prose (`UNSUPPORTED_INTEGRATIONS` in `packages/job-engine/src/connectors/stubs.ts`).
7. **No employer-response tracking** (confirmation, assessment, interview, rejection, offer emails).
8. **Notifications are ad-hoc** `prisma.notification.create` calls (4 call sites) without de-duplication keys or quiet
   hours.
9. **Demo data is 32 static shared-catalogue jobs** (`DEMO_JOBS`), with no cross-provider duplicates or scripted
   outcomes, so the pipeline cannot be demonstrated end to end.
10. **Policy and documentation state the opposite of the new capability** ("ApplyWise never submits an application for
    you"). Section 5 lists every invariant that changes and how the new design keeps its intent.

### 1.3 Classification totals (section 2 matrix, 48 requirements)

| EXISTS | EXTEND | REFACTOR | NEW |
| --- | --- | --- | --- |
| 8 | 19 | 5 | 16 |

Per-source discovery and auto-apply classifications (including every EXTERNAL_LIMITATION) are in section 2.9.

---

## 2. Requirement matrix

### 2.1 Identity, consent and candidate data

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R1 | Authentication & consent | EXTEND | Auth.js v5 credentials/JWT (`apps/web/src/auth.ts`, `auth.config.ts`); `middleware.ts` (auth redirects, same-origin check on mutating `/api`, `x-request-id`); `route()` wrapper (`server/http.ts`: auth, rate limit, Zod); email verification (`email-verification.service.ts`, `User.emailVerifiedAt`). `UserConsent` with `ConsentType {CV_PROCESSING, AI_PROCESSING, EMAIL_SENDING, ANALYTICS}`, `consentService.require()`, AI consent scoped to local/external provider (`aiConsentScope`). No consent covers unattended submission. | Auth unchanged. Migration adds `ConsentType.AUTO_APPLY`; `consentService` gains the `autoApply` key. AUTO submission requires it (a blocker in `automationSettingsService.readiness`). Email applications additionally need `EMAIL_SENDING` and a verified address (`ExecutorSelectionInput.emailSendingConsent`, `userEmailVerified` in `apps/web/src/server/services/executors/types.ts`). Revoking consent must stop queued executions: `applicationExecutionService.execute` re-checks automation, AUTO mode and the `AUTO_APPLY` consent for policy approvals at execution time. |
| R2 | CandidateProfile / CandidatePreference | EXISTS | `CandidateProfile` (name, email, phone, `yoe`, `currentTitle`, `currentCompany`, links, `factsVersion`); `CandidatePreference` (`preferredLocations`, `workModePreference`, `openToRelocation`, `targetRoles`, `noticePeriod`, `expectedSalaryMin/Max`, `currency`); `profileService.update`. | Reused as the first answer source (`AnswerSources.profile` / `.preference` in `packages/job-engine/src/automation/questions.ts`) and as rule/matching inputs. There are no columns for work authorisation, visa sponsorship, earliest start date, current salary or highest education: those resolve **only** from user-entered `CandidateAnswer` rows (R12), otherwise UNKNOWN. |
| R3 | TruthBank + claim validation (verified-fact model) | EXISTS | `TruthBankItem` + `TruthStatus {PARSED_UNVERIFIED, USER_VERIFIED, USER_REJECTED, USER_EDITED}`; `verifiedSourceFacts()`; `validateClaims()` (`claim-validator-v1`) run in `applicationService.runPrepare` and on user edits in `applicationService.update`; positive questionnaire answers become `QUESTIONNAIRE_ANSWER` facts (`questionnaire.service.ts saveAnswers`). | Unchanged, and promoted to a hard gate: AUTO submits only when there is no unsupported claim (architecture doc: tailored resume, cover letter, answers), surfaced as `ReviewQueueItem.tailored.unsupportedClaims`; otherwise the application waits for approval. Resolved answers come from verified sources by construction; see R10 for how the cover letter is covered. |
| R4 | Experience / Education / Project / CandidateSkill | EXISTS | Models with per-row `TruthStatus`; `CandidateSkill @@unique([profileId, canonicalName])`; `Skill` taxonomy with admin aliases loaded at start-up (`registerSkillAliases` in `instrumentation-node.ts`). `CandidateSkill.yearsUsed` exists in the schema, but **no baseline code writes it** (only read in `profile.service.ts` and the validation schema). | Reused. Because per-skill years are never verified, "years of experience with X" questions resolve from a user answer (`skill_experience_years:<skill>` key) or become UNKNOWN; total YOE must not be presented as a per-skill figure. |
| R5 | Resume parsing | EXISTS | Upload validation (extension, MIME, magic bytes, size, `server/malware.ts`), encrypted storage (`server/storage.ts`), `cv.parse` task → `resumeService.runParse`: `extractTextFromResume` (`packages/resume-engine`), AI `parseCv` only with AI consent, else `parseCvText`; `applyParsedCv` stores unverified facts; extracted text and sections encrypted. | Unchanged. Note: `applyParsedCv` (`packages/database/src/profile-import.ts`) deletes **all** of the user's `PARSED_UNVERIFIED` CV facts before inserting, so facts are per profile, not per resume. Resume selection (R8) therefore ranks resume *documents* against verified evidence; it does not create per-resume truth banks. |
| R6 | Resume versions | EXISTS | `ResumeVersion` (`ORIGINAL` / `EDITED` / `TAILORED`, `parentVersionId`, `contentHash`, `applicationId`); `resumeService.listVersions / getVersion / diff / snapshotProfile / export`; deterministic PDF/DOCX/TXT/HTML exports; `applicationService.approve` creates the `TAILORED` version. | Reused. The executor sends an already-rendered, approved document through `SubmissionPayload.resume` (`packages/job-engine/src/providers/types.ts`); no new version kinds. |
| R7 | Multiple resumes | EXTEND | Several `Resume` rows per user are possible, but `resumeService.upload` sets `isPrimary: false` on every other resume; no label or target roles; each parse creates an `ORIGINAL` version. | Migration adds `Resume.label` and `Resume.targetRoles`. Existing rows keep `label = NULL`, `targetRoles = {}`; `isPrimary` keeps its meaning (tie-breaker, fallback). |
| R8 | Automatic resume selection (`selectedResumeId`, score, reason, override) | NEW | None. Tailoring always starts from `documentFromProfile(profile)`; the only per-application choice is the email attachment (`ApplicationEmailDraft.resumeVersionId` in `emailService.preview`). | Pure `selectResume` (`packages/job-engine/src/automation/resume-selection.ts`, deterministic, verified skills only) + `resumeSelectionService.selectForApplication / override` (`apps/web/src/server/services/resume-selection.service.ts`). Stored on `Application.selectedResumeId` (FK, `SET NULL`), `selectedResumeVersionId` (soft reference), `resumeSelectionScore`, `resumeSelectionReason`, `resumeSelectionOverridden`. A user override is never replaced by a later automatic selection. |
| R9 | Tailored resumes (no fabrication) | EXTEND | `planTailoredResume` + `sanitizeTailoredPlan` (bullets re-homed to the role owning the cited facts; cross-role rewrites dropped), `validateClaims`, `buildTailoredDocument` (original bullets always kept; `apps/web/test/tailored-document.test.ts`), `TailoredResume` never overwrites the base resume. | Keep the generator and validator. Add: `AutomationSettings.tailorResume` switch; the tailoring base follows the selected resume (R8); unsupported claims block AUTO (R3). |
| R10 | Cover letters | EXTEND | `generateCoverLetter` / `fallbackCoverLetter` with cited `claims`; `CoverLetter` (`originalBody`, `status`, prompt/model metadata). | Keep. Add `AutomationSettings.generateCoverLetter`; the provider must accept one (`ApplicationRequirements.acceptsCoverLetter`). Truth checking relies on the workflow's own guard (`generateCoverLetter` runs `validateClaims` on its claims and falls back to `fallbackCoverLetter` on rejection): the routing gate `truthOk` passed to `routeAfterPreparation` counts only the tailored-resume validation, and user edits to a cover letter are not re-validated (as in the baseline). |
| R11 | Screening answers | REFACTOR | `runPrepare` answers `job.screeningQuestions.slice(0, 8)` with `generateScreeningAnswer`; the deterministic fallback returns a placeholder sentence with `canConfirm: false` when nothing is verified (`packages/ai/src/fallbacks.ts fallbackScreeningAnswer`). `ScreeningAnswerDraft` has no question key, source, required flag or resolved flag. | Answers are produced by the deterministic resolver (R13) first; generation is only a last step for non-sensitive questions with cited facts. Migration adds `ScreeningAnswerDraft.questionKey`, `answerSource` (`AnswerSource`), `required`, `resolved`. An unresolved required answer is never sent: the application becomes `NEEDS_INFORMATION` with `Application.pendingQuestions`. |
| R12 | Questionnaire → reusable candidate answers | NEW | Per-job `JobQuestionnaire` / `JobQuestion` / `JobAnswer`. Only positive skill answers and free-text details become reusable facts (`QUESTIONNAIRE_ANSWER`), and the notice-period answer updates `CandidatePreference.noticePeriod`. Salary, work authorisation, visa, relocation and start-date answers are not reusable across jobs. | `CandidateAnswer` table (`@@unique([userId, questionKey])`, user-authored, `status` default `USER_VERIFIED`) + `candidateAnswersService` (`list / upsert / remove / answerSources`). Answers given to resolve `NEEDS_INFORMATION` are saved here and reused for later applications; questionnaire answers keep flowing into the TruthBank as before. |
| R13 | Answer order (profile → TruthBank → previous answers → user answers), NEEDS_INFORMATION, resume field | NEW | No classifier or resolver. The extension has a label→field matcher (`apps/extension/src/lib/form-match.ts` `SYNONYMS`) for prefill only. | `classifyQuestion`, `collectApplicationQuestions`, `resolveApplicationAnswers` (`packages/job-engine/src/automation/questions.ts`, `answers-v1`): verified profile/preferences → TruthBank facts and verified skills → previous `JobAnswer`s → `CandidateAnswer`. Sensitive keys (salary, notice, work authorisation, visa, relocation, start date) resolve only from values the user entered. The `resume` key is satisfied by the selected/tailored document (R8). Unknown required → `NEEDS_INFORMATION` (`ManualActionReason.UNKNOWN_REQUIRED_QUESTION` if discovered during execution). |

### 2.2 Jobs: ingestion, feeds, normalisation, de-duplication, matching

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R14 | Job ingestion | EXISTS | `CONNECTORS` (`packages/job-engine/src/connectors/index.ts`): manual, paste, career-page URL (page not fetched), CSV, forwarded email, browser import (extension, `userConfirmed: true`), seeded demo, plus disabled stubs (`officialPartnerApiConnector`, `apiKeyFeedConnector`, `greenhouseBoardApiConnector`, `leverPostingsApiConnector`); `jobsService.importVia / importRaws`; `JobImportEvent.rawPayload`. | Reused unchanged; every provider in the new registry imports through `jobsService.importRaws` → `persistNormalizedJob`. |
| R15 | Job feeds (search APIs, company boards, mailbox alerts, forwarding) | EXTEND | `JobFeedKind {SEARCH, COMPANY_BOARD, MAILBOX}`; search adapters (Adzuna, Himalayas, Jobicy, The Muse: `feeds/search`), board adapters (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee: `feeds/boards`), alert parsers (`feeds/alerts`, senders for LinkedIn, Indeed, Naukri, Foundit, Instahyre, Cutshort, Wellfound, Glassdoor, Hirist, iimjobs), IMAP / Gmail API / Microsoft (`packages/mail-sources`), signed forwarding webhook (`/api/inbound/email`, `jobFeedsService.handleInbound`); scheduler `jobFeedsService.tick` from `instrumentation-node.ts`. | Keep every adapter. Migration adds `JobFeedKind.DEMO` for the demo provider. The orchestrator drives discovery by claiming the user's due feeds with the existing lease and calling `runSync` (architecture diagram "claimDue feeds → runSync"), so a run's counts come from the same sync code. `AutomationSettings.enabledProviders` narrows which feeds' jobs are eligible, it does not create new feed types. |
| R16 | Normalisation | EXISTS | `normalizeRawJob` → `parseJobDescription` (`jd-parser.ts`), optional AI `parseJob` with literal-value checks, skill taxonomy (`taxonomy.ts`), locations (`locations.ts`); `job.normalize` task re-scores on demand. | Reused. `JobProvider.normalize` is optional and defaults to `normalizeRawJob`. |
| R17 | De-duplication, including across providers | EXTEND | `Job @@unique([ownerUserId, dedupeKey])` with `createOrFindRacing` (P2002 → existing row); cross-source merge by `matchKey` for private jobs within 60 days (`MERGE_WINDOW_MS`), one `JobSource` per source; tested in `apps/web/test/job-feeds.test.ts` ("keeps one job, adds the second source..."). Limits: `jobMatchKey` returns `null` when title or company is unknown; the shared catalogue (`ownerUserId: null`) is never merged; outside the window a second `Job` row is created. `Application @@unique([userId, jobId])` is per `Job` row only. | Keep the job-level merge. Add application-level identity: `Application.canonicalJobKey` (Job `matchKey`, shared by merged duplicates) and `ApplicationExecution.idempotencyKey = userId:canonicalJobKey` (unique), plus the rule check `already_applied`. Two `Job` rows that share the canonical key are therefore never both submitted by an executor (legacy caveat: section 3.3 item 3). When `matchKey` is null the key falls back to the job's own dedupe key (`canonicalJobKey()` in `apps/web/src/server/services/provider-job-ref.ts`: `matchKey ?? "dedupe:" + dedupeKey`). |
| R18 | Deterministic matching + component explanations | EXISTS | `computeMatchReport` (factors: required-skill coverage 35, evidence strength 25, role & seniority 15, domain 10, location/work mode 10, resume format 5, penalties); `recomputeMatchScores`; `JobMatchFactor.explanation`; UI `components/jobs/match-report.tsx`. | Reused unchanged. The rule engine takes `RuleMatchInput` (score, missing mandatory skills, location fit) from this report and never recomputes it; factors are shown in the review queue as `MatchFactorView`. |

### 2.3 Decisioning: rules, modes, routing

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R19 | Automation rule engine | NEW | No rule engine. Precursors are interactive inbox filters (`jobListQuerySchema` in `packages/validation/src/jobs.ts`), the feed relevance pre-filter (`packages/job-engine/src/feeds/relevance.ts`) and per-job ignore (`UserJobState.ignored`). See 2.3.1. | Pure `evaluateAutomationRules` / `automationScoreDecision` (`packages/job-engine/src/automation/rules.ts`, `rules-v1`), configuration `AutomationSettings` (thresholds, providers, daily limit) + `AutomationRule` (filters), merged by `ruleConfig()` in `automation-settings.service.ts`. Output `RuleEvaluation` (decision, score decision, checks with plain-language detail, reasons, `deferredByDailyLimit`) is stored on `Application.automationDecision`, `decisionScore`, `decisionReasons`, `rulesVersion`, `evaluatedAt`. |
| R20 | ApplicationMode MANUAL / REVIEW / AUTO | NEW | None. Every prepared application lands in `READY_FOR_REVIEW`; the user applies. | `ApplicationMode` enum; `AutomationSettings.mode` (default `MANUAL`, `enabled` default `false`) and a per-application snapshot `Application.mode`. MANUAL never submits; REVIEW submits after approval; AUTO submits only when every condition in the architecture doc holds. |
| R21 | Configurable routing IGNORE / RECOMMEND / REVIEW / AUTO_ELIGIBLE | NEW | `JobMatchReport.applicationRecommendation` (`apply` / `apply_with_caution` / `do_not_prioritize`) and `scoreLabel` are informational; nothing is routed. | `AutomationDecision` enum. Thresholds `recommendScore` (50), `minMatchScore` (70), `autoApplyScore` (90) are per user (migration defaults). IGNORE → `REJECTED_BY_RULES`; RECOMMEND → `MATCHED` (shown, not prepared); REVIEW → `MATCHED`, then preparation; AUTO_ELIGIBLE → `AUTO_ELIGIBLE`, then preparation; after preparation the mode decides the route (R29). |

#### 2.3.1 Rule inputs

| Rule input | Baseline precursor | Target (`AutomationRuleConfig` field → check key, effect) | Class |
| --- | --- | --- | --- |
| Minimum score | `JobMatchScore.score`; inbox filter `minScore` | `recommendScore` / `minMatchScore` / `autoApplyScore` → `match_score` | NEW |
| Titles | Feed pre-filter `titleMatchesRole` against `targetRoles` (boards/searches only); free-text `q` | `targetTitles` → `target_title` (cap RECOMMEND); `excludedTitles` → `excluded_title` (IGNORE) | NEW |
| Companies | Inbox filter `company`; per-job `UserJobState.ignored` | `preferredCompanies` → `preferred_company` (raise to REVIEW); `excludedCompanies` → `excluded_company` (IGNORE) | NEW |
| Skills | Missing-mandatory penalty in the match report | `requiredSkills` + `requiredSkillsMode any/all` → `required_skills` (IGNORE); `allowMissingMandatorySkills` → `mandatory_skills` (cap REVIEW) | NEW |
| Experience | `scoreYoe` in matching; inbox filters `minYoe` / `maxYoe` | `maxExperienceGapYears` → `experience` (IGNORE) | NEW |
| Location | `scoreLocation`; feed relevance; inbox filter `location` | `locationMode preferences/any` → `location` (poor fit IGNORE, unknown cap REVIEW) | NEW |
| Work mode | Inbox filter `workMode`; `workModePreference` in matching | `allowedWorkModes` → `work_mode` (IGNORE; unknown cap REVIEW) | NEW |
| Salary | None (salary kept only when the parser found an explicit figure) | `minSalary` + `salaryCurrency` → `salary` (IGNORE only when the stated maximum is below the minimum) | NEW |
| Job age | Inbox filter `postedWithinDays` | `maxJobAgeDays` → `job_age` (postedAt, else foundAt; IGNORE) | NEW |
| Provider | Inbox filter `platform`; `JobFeed.provider` | `enabledProviders` (provider-registry ids) → `provider` (IGNORE) | NEW |
| Application type | Inbox filter `applyMethod` (`ApplyMethod {PLATFORM, CAREER_PAGE, EMAIL, MANUAL}`) | `allowedApplyMethods` → `apply_method` (IGNORE) | NEW |
| Description level | "Summary only" badge (`JobDescriptionLevel.SNIPPET`) | `description_level` (cap REVIEW) | NEW |
| Already applied | `Application @@unique([userId, jobId])` (per Job row) | `already_applied` via `canonicalJobKey` (IGNORE) | NEW |
| Daily limit | None | `maxApplicationsPerDay` (bounded by `AUTOMATION_MAX_DAILY_LIMIT`) → `daily_limit` (defer to next day, never drop) | NEW |

### 2.4 Providers, executors and the platform-protection policy

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R22 | Provider abstraction (`discover`, `getDetails`, `normalize`, `getApplicationRequirements`, `supportsApplication`, `submitApplication`, `checkApplicationStatus`) + capability metadata | NEW | Four unrelated interfaces: `SearchProviderAdapter` and `BoardAdapter` (`packages/job-engine/src/feeds/types.ts`), `JobSourceConnector` (`connectors/types.ts`), alert parsers. No apply-side or status methods. Capability knowledge is static prose: `UNSUPPORTED_INTEGRATIONS`, `detectUnsupportedPortal` (`feeds/boards/detect.ts`), connector `isConfigured()` flags shown on `settings/integrations/page.tsx`. | `JobProvider` (`packages/job-engine/src/providers/types.ts`, every method optional) + registry (`providers/registry.ts`: `listProviders`, `getProvider`, `providerInfos(env)`, `sourceProviderIdForJob`, `applicationProviderForJob`). Providers **wrap** the existing adapters instead of replacing them. `ProviderInfo.capabilities` reports DISCOVERY, DETAIL_FETCH, QUESTION_EXTRACTION, AUTO_APPLY, STATUS_TRACKING as one of the `CAPABILITY_STATUSES` (`packages/types/src/automation.ts`), resolved against the environment and safe to send to the browser. |
| R23 | No local browser: submission runs in a worker with Playwright + Chromium | NEW | No server-side browser. Playwright is only the E2E test runner (`@playwright/test` devDependency, `apps/web/playwright.config.ts`). BullMQ workers start inside the Next.js process (`getBullQueue`, opt-out `APPLYWISE_DISABLE_WORKER`); the feed scheduler runs in `instrumentation-node.ts`. The only browser-side automation is the extension, in the user's own browser, after a click. | Separate worker process `apps/web/src/worker/main.ts` (package script `worker`: BullMQ consumers, scheduler, health endpoint on `WORKER_HEALTH_PORT`), runtime dependency `playwright-core`, new `apply` queue lane (`APPLY_QUEUE_CONCURRENCY`). The browser executor is off by default (`BROWSER_EXECUTOR_ENABLED`), limited to `BROWSER_EXECUTOR_PROVIDERS` (default `demo`), with `BROWSER_EXECUTOR_DRY_RUN`, `BROWSER_EXECUTOR_HEADLESS`, `BROWSER_EXECUTOR_TIMEOUT_MS`. Nothing ever runs in, or requires, the user's browser. A worker image with Chromium is an operator task (the repository has no Dockerfile). |
| R24 | ApplicationExecutor (API / Browser / Manual) | NEW | None ("no code path submits third-party forms", `docs/implementation-plan.md`). | `ApplicationExecutor` / `ExecutorSelection` (`apps/web/src/server/services/executors/types.ts`): API (`api:demo`, `api:email`), BROWSER (`browser:demo-ats`, experimental ATS adapters), MANUAL (handoff). Executors are invoked only by `applicationExecutionService.execute`, which holds the idempotency claim, the daily-limit slot and the `APPROVED → APPLYING` transition. `idempotentSubmission` decides whether a crashed attempt may be retried. |
| R25 | Platform-protection policy (no CAPTCHA/MFA bypass) + MANUAL_ACTION_REQUIRED reasons | EXTEND | `docs/platform-integration-policy.md` "Prohibited — never implement" (scraping, credential harvesting, CAPTCHA bypass, automated LinkedIn activity, unattended submission, extension background activity, fabrication). No machine-readable reason when a flow cannot proceed. | Policy kept and restated for executors: no CAPTCHA/MFA/anti-bot bypass, no stealth fingerprinting, no rate-limit circumvention, no LinkedIn automation. New `ManualActionReason` enum (`CAPTCHA`, `MFA`, `LOGIN_REQUIRED`, `UNSUPPORTED_FLOW`, `UNKNOWN_REQUIRED_QUESTION`, `PROVIDER_RESTRICTION`, `AUTOMATION_NOT_SUPPORTED`, `SUBMISSION_UNCERTAIN`) with user-facing labels, stored on `Application.manualActionReason` / `manualActionDetail` and `ApplicationExecution.manualActionReason`. The policy document itself must be amended (section 5). |
| R26 | Manual handoff + browser extension as assistant | EXTEND | "Open official apply page" (`applicationService.markOpened`), "I submitted it myself" (`markSubmitted`), extension prefill with a 10-minute signed code (`extensionService.issuePrefill / resolvePrefill`) allowed only for `APPROVED` / `OPENED_APPLY_PAGE`. | `ManualHandoffPackage` contract (job, apply URL / HR email, reason, match, selected resume, tailored version, cover letter, resolved answers with sources, instructions) produced by the MANUAL executor. The extension stays an assistant with the same guarantees (no submit, no click, no content scripts): prefill is extended to handoffs (`PREFILL_STATUSES` = `APPROVED`, `OPENED_APPLY_PAGE`, `MANUAL_ACTION_REQUIRED`, `FAILED` in `extension.service.ts`), prefill answers carry the classifier key and exclude unresolved drafts and the "cannot confirm" placeholder, and the popup lists handoffs (`apps/extension/src/lib/handoff.ts`). APPROVED applications in REVIEW / AUTO mode are not offered, because an executor will submit them. |

### 2.5 Application lifecycle

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R27 | Application state machine | REFACTOR | `apps/web/src/server/domain/application-state.ts`: 13 states, 10 actions; the transition helper in `application.service.ts` reads the status, computes `nextStatus`, then `update`s by id only (no status guard); `emailService.runSend` does the same. See 2.5.1. | Same module, extended (25 states, 22 actions incl. `match_started`, `evaluate`, `policy_approve`, `needs_information`, `information_provided`, `manual_action`, `execute_started/succeeded/failed`, `decline`, `status_update`). Every transition goes through `transitionApplication` (`apps/web/src/server/services/application-transitions.ts`): compare-and-set `updateMany where status = <read status>`, one re-read on conflict, then `Errors.conflict`. The manual tracker (`track`) can never set APPROVED, APPLYING, APPLIED, SUBMITTED, EMAIL_SENT or AUTO_ELIGIBLE. |
| R28 | ApplicationEvent history | EXTEND | `ApplicationEvent` (type, from/to status, message, metadata) written on every baseline transition; shown in the application "Timeline" tab. No actor. | Migration adds `ApplicationEvent.actor` (default `'user'`; `user` / `system` / `policy` / `executor`). `recordApplicationEvent` adds timeline entries without a status change (resume selected, daily limit reached, answers resolved). Messages are capped at 500 characters and never contain answers or CV text. |
| R29 | Application preparation pipeline | EXTEND | `applicationService.prepare` → `application.prepare` task → `runPrepare`: tailored plan, cover letter, up to 8 screening answers, HR email draft, claim validation, all in one transaction, then `READY_FOR_REVIEW`. `batchPrepare` max 10. | Keep `runPrepare` as the single preparation path and extend it (architecture: `application.service.ts runPrepare` + `application-routing.service.ts`): resume selection → optional tailoring / cover letter (settings) → question collection and resolution → truth validation → routing by mode: `READY_FOR_REVIEW` (MANUAL), `WAITING_APPROVAL` (REVIEW, or AUTO with a failed condition), `APPROVED` by `policy_approve` (AUTO, all conditions hold), `NEEDS_INFORMATION`, or `MANUAL_ACTION_REQUIRED` (no executor). Timestamps `preparedAt`, `nextActionAt`. |

#### 2.5.1 Application states

| State | In baseline | Reached by (target) | Notes |
| --- | --- | --- | --- |
| SAVED | yes | `getOrCreate` (user) | Manual flow start; unchanged |
| DISCOVERED | **new** | orchestrator creates the application for a matched job | `origin = AUTOMATION` |
| MATCHING | **new** | `match_started` | transient |
| MATCHED | **new** | `match_completed`; `evaluate` (RECOMMEND or REVIEW) | decision stored in `automationDecision`; REVIEW is then prepared |
| REJECTED_BY_RULES | **new** | `evaluate` (IGNORE) | re-evaluated when profile, rules or job change; "prepare anyway" allowed |
| AUTO_ELIGIBLE | **new** | `evaluate` (AUTO_ELIGIBLE) | not settable by the tracker |
| PREPARING | yes | `prepare` | now also from the pipeline states |
| READY_FOR_REVIEW | yes | `preparation_succeeded` (MANUAL mode / user-started) | unchanged meaning |
| WAITING_APPROVAL | **new** | `preparation_succeeded` (REVIEW, or AUTO with a failed condition) | the review queue |
| NEEDS_INFORMATION | **new** | `needs_information` (unknown required answer) | `pendingQuestions`; `information_provided` → PREPARING |
| APPROVED | yes | `approve` (user) or `policy_approve` (AUTO, from PREPARING only) | `approvalSource` records which |
| APPLYING | **new** | `execute_started` (from APPROVED, or a retry of FAILED / MANUAL_ACTION_REQUIRED) | only one worker can win the CAS |
| APPLIED | **new** | `execute_succeeded` (only from APPLYING) | sent by an executor; `appliedAt`, `externalApplicationId` |
| FAILED | **new** | `execute_failed`, `preparation_failed` | retried only when definitely not submitted |
| MANUAL_ACTION_REQUIRED | **new** | `manual_action` | `manualActionReason`; handoff |
| OPENED_APPLY_PAGE | yes | `open_apply_page` | now also from FAILED / MANUAL_ACTION_REQUIRED |
| EMAIL_DRAFT_READY | yes | `email_preview` | unchanged |
| EMAIL_SENT | yes | `email_sent` (confirmed send endpoint only) | unchanged; automated email applications end in APPLIED |
| SUBMITTED | yes | `mark_submitted` (user only) | unchanged |
| ASSESSMENT | **new** | `status_update` (email tracking / provider status) or `track` | employer response |
| INTERVIEW | yes | `status_update` or `track` | now also reachable from APPLIED / ASSESSMENT |
| OFFER | yes | `status_update` or `track` | unchanged terminal |
| REJECTED | yes | `status_update` or `track` | employer rejection; distinct from REJECTED_BY_RULES |
| WITHDRAWN | yes | `track`, `decline` | `decline` available from every not-yet-sent state |
| EXPIRED | yes | `track` | unchanged |

Totals: 13 existing states kept with their manual transitions, 12 new states. RECOMMEND and REVIEW are decisions
(`Application.automationDecision`), not states.

### 2.6 Orchestration, background work and reliability

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R30 | Background tasks + recurring workflows | EXTEND | `enqueue(name, payload, {userId, runAt, dedupeKey})` with `BackgroundTask` tracking; tasks `cv.parse`, `job.normalize`, `job.match`, `application.prepare`, `email.draft`, `email.send`, `email.verification`, `feeds.sync`, `reminder.dispatch`; lanes `default` / `feeds`; the only recurring job is the feed tick (`setInterval` in `instrumentation-node.ts`, `FEEDS_SCHEDULER`, `FEEDS_TICK_SECONDS`). See 2.6.1. | Same queue, new task names and an `apply` lane; recurring work is driven by a scheduler tick (worker process or instrumentation, `AUTOMATION_SCHEDULER`, `AUTOMATION_TICK_SECONDS`) that claims per-user leases and enqueues `automation.run`; handlers registered in `queue/handlers.ts`. |
| R31 | AutomationOrchestrator | NEW | None (the feed sync ends with a daily "new matches" notification). | `automationOrchestrator.tick / runForUser / resumeApplication / dailySummary` (`apps/web/src/server/services/automation-orchestrator.service.ts`): discover → match → rules → prepare (bounded by `AUTOMATION_MAX_JOBS_PER_RUN`, `AUTOMATION_MAX_PREPARE_PER_RUN`) → route; metrics via `automationRunsService.increment / item`. |
| R32 | Idempotency (DB uniqueness, idempotency keys, atomic transitions, queue job ids, leases) | REFACTOR | See 2.6.2: uniqueness and feed leases existed; transitions and `getOrCreate` were race-prone; the memory driver ignored `dedupeKey`. | See 2.6.2. |
| R33 | Atomic daily limit | NEW | None. | `DailyApplicationCounter` (`@@id([userId, day])`) + `dailyLimitService.reserve / release / countToday` (`daily-limit.service.ts`): `INSERT … ON CONFLICT DO NOTHING`, then `updateMany where count < limit` (one conditional UPDATE, row lock serialises workers). Day key in the user's time zone (`automation-time.ts`). Released only when the attempt definitely did not submit; the slot day is kept on `ApplicationExecution.slotDay`. |

#### 2.6.1 Workflows

| Workflow | Task | Baseline | Class | Decision |
| --- | --- | --- | --- | --- |
| feeds.sync | `feeds.sync` | exists (feeds lane, per-feed dedupe key `feeds.sync:<feedId>`) | EXISTS | reused by the orchestrator |
| jobs.normalize | `job.normalize` | exists (normalisation is synchronous on import; the task re-scores) | EXISTS | unchanged |
| jobs.match | `job.match` | exists (`recomputeMatchScores`) | EXISTS | unchanged; the orchestrator matches inline for the jobs it found |
| applications.evaluate | `application.evaluate` | none | NEW | `automationOrchestrator.resumeApplication`: re-evaluates and routes one automation application, or resumes preparation after the user answered `NEEDS_INFORMATION` questions |
| applications.prepare | `application.prepare` | exists (`runPrepare`) | EXTEND | routing by mode added (R29) |
| applications.execute | `application.execute` | none | NEW | `apply` lane; `dedupeKey` per application |
| applications.status.sync | `application.status_sync` | none | NEW | provider `checkApplicationStatus` where supported |
| notifications.dispatch | `notification.dispatch` | only `reminder.dispatch` (per-application reminder) | NEW | releases notifications deferred by quiet hours (`notificationService.dispatchDue`) |
| daily.summary | `summary.daily` | none (feed sync sends one "new matches" notification per day) | NEW | per-user summary at `dailySummaryHour`, once per day (`lastDailySummaryDay`) |
| (orchestration) | `automation.run`, `execution.recover` | none | NEW | per-user run; recovery of expired execution leases |

#### 2.6.2 Idempotency and concurrency

| Mechanism | Baseline | Class | Decision |
| --- | --- | --- | --- |
| DB uniqueness | `Job (ownerUserId, dedupeKey)`, `Application (userId, jobId)`, `JobMatchScore (userId, jobId)`, `JobQuestionnaire (userId, jobId)`, `JobQuestion (questionnaireId, key)`, `UserConsent (userId, type)`, `CandidateSkill (profileId, canonicalName)`, `FeedProviderUsage (provider, day)` | EXTEND | New unique keys: `ApplicationExecution.idempotencyKey`, `Notification (userId, dedupeKey)`, `CandidateAnswer (userId, questionKey)`, `ApplicationMessage (userId, messageHash)`, `ProviderConnection (userId, provider)`, `AutomationSettings.userId`, `AutomationRule.userId`, `DailyApplicationCounter (userId, day)`. `applicationService.getOrCreate` did `findUnique` then `create` with no P2002 handling; the orchestrator creates applications create-or-find on P2002. |
| Idempotency keys | none for submissions (email send is protected by the digest-bound token) | NEW | `userId:canonicalJobKey`; `SUCCEEDED` is terminal; providers that support it deduplicate on `SubmissionPayload.idempotencyKey`. |
| Atomic transitions | read-then-update (`transition()` in `application.service.ts`, `emailService.runSend`) | REFACTOR | `transitionApplication` compare-and-set for every transition. |
| Queue job ids | BullMQ `jobId` from `dedupeKey`; the memory driver ignored `dedupeKey` | EXTEND | memory-driver dedupe set; dedupe keys for `automation.run` and `application.execute`. |
| Leases | `JobFeed.nextSyncAt` claim with `LEASE_MS` 10 min, `runInProgress` guard | EXTEND | `AutomationSettings.runLeaseUntil` (one run per user), `ApplicationExecution.leaseUntil` (crash recovery: an expired RUNNING execution is retried only when the executor is idempotent, else `MANUAL_ACTION_REQUIRED` / `SUBMISSION_UNCERTAIN`). |

### 2.7 User interface

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R34 | Automation Control Center | NEW | None. Settings has Account, Privacy & consent, Integrations (`components/settings-nav.tsx`). | Page backed by `AutomationSettingsView` (`automationSettingsService.getView / update`): enabled, mode, thresholds, daily limit, job age, frequency, providers, quiet hours, time zone, tailoring / cover letter / email applications switches, rules, AUTO_APPLY consent, live status (last/next run, applications today, quiet hours) and `readiness.blockers`. Settings changes bump `rulesVersion` and are audited (`automation.settings_updated`). |
| R35 | Automation Runs (+ inspection) | NEW | Per-source history only (`JobFeedRun`: fetched / created / merged / skipped / error). | `AutomationRun` (counts for every stage, `details`, `error`) + `AutomationRunItem` (stage, outcome, message, job/application ids); views `AutomationRunSummary`, `AutomationRunDetail` with `AutomationRunProviderDetail` (which reuses feed counts). |
| R36 | Job Sources UI with capability status | EXTEND | `/jobs/sources` (`components/sources/*`): alerts, companies, searches, per-feed status badges (ACTIVE / PAUSED / ERROR / NEEDS_ATTENTION, "Needs attention"), sync now; `settings/integrations` lists connectors and `UNSUPPORTED_INTEGRATIONS`. | Keep the page and add provider cards (`ProviderSourceCard`: `cardStatus` CONNECTED / NEEDS_AUTHENTICATION / WORKING / LIMITED / MANUAL_ONLY / ERROR / NOT_CONFIGURED, per-capability status, external requirements, enabled-for-automation switch, connection state, feeds and job counts). |
| R37 | Dashboard metrics | EXTEND | `dashboard/page.tsx`: 4 tiles (jobs in inbox, ready for review, approved / in progress, submitted / sent) + latest notifications. | `DashboardSummary`: jobs discovered today, new / strong matches, applications today / this week, waiting approval, needs information, manual action required, interviews, assessments, offers, rejections, automation status. |
| R38 | Job matches page | EXTEND | `/jobs` inbox (`components/jobs/jobs-inbox.tsx`): filters (platform, company, location, work mode, YOE, posted within, min score, apply method, saved, new), sort by score; job detail with the match report. | Add the automation decision and its reasons (`RuleEvaluation.checks`) next to the unchanged match factors, and a "prepare anyway" action for rule-rejected jobs. |
| R39 | Review queue | NEW | `/applications` lists all applications; review happens per application in the workspace. | `ReviewQueueItem` (job, match factors, decision + reasons, selected resume + override, tailored summary with unsupported-claim count, cover letter, answers with sources, pending questions, warnings, selected executor, manual-action reason) for `WAITING_APPROVAL` / `NEEDS_INFORMATION` / `MANUAL_ACTION_REQUIRED` / `READY_FOR_REVIEW`; approve, decline, answer questions, override resume. |
| R40 | Applications page + timeline | EXTEND | `/applications` and `/applications/[id]` (`components/applications/application-workspace.tsx`, Timeline tab `data-testid="timeline"`), manual tracker via `manualTrackingOptions`. | Show mode, origin, decision, executor and attempts (`ApplicationExecution`), manual-action reason with the handoff package, employer messages (`ApplicationMessage`), and the actor of each event. |

### 2.8 Tracking, notifications, security, demo, quality

| # | Requirement | Class | Baseline evidence | Decision |
| --- | --- | --- | --- | --- |
| R41 | Email status tracking | NEW | None. Mailbox access downloads only known job-alert senders (`normalizeSenders`, `gmailQuery` in `packages/mail-sources/src/senders.ts`); the inbound webhook handles alerts and Gmail's forwarding confirmation only. | Pure `classifyStatusEmail` / `associateStatusEmail` / `statusForMessageCategory` (`packages/job-engine/src/automation/email-status.ts`, `STATUS_EMAIL_MIN_CONFIDENCE = 0.7`) + `applicationEmailTrackingService.ingest` (sources `inbound` / `mailbox` / `demo`). Stores only `ApplicationMessage` metadata (message-id hash, sender domain, truncated subject, category, confidence) and applies `status_update` when confident. Reuses `packages/mail-sources`; widening the sender filter beyond job-alert senders is a privacy change (section 5). |
| R42 | Notifications | REFACTOR | `Notification` (type, title, body, link, `scheduledFor`, `readAt`), `GET/POST /api/notifications`; 4 direct `prisma.notification.create` call sites (`application.service.ts dispatchReminder`, `job-feeds.service.ts` new matches / inbound / needs attention); "one per day" implemented with find-then-create. | `notificationService.notify` (`notification.service.ts`) as the single entry point: `Notification.dedupeKey` (unique per user) makes retries idempotent; quiet hours defer delivery via `scheduledFor` (security notices bypass); `visibleNotificationsWhere` hides deferred ones; `notification.dispatch` releases them. Existing call sites should migrate to it (section 8). |
| R43 | Security: encryption, ownership checks, PII-safe logging, audit | EXTEND | `encryptText` / `decryptText` (AES-256-GCM), `assertOwned` / `jobVisibleTo`, `redact()` (keys such as `answer`, `salary`, `token`, `cookie`, `body`, `resume` redacted; e-mails, phones, bearer tokens scrubbed), `audit()` with redacted metadata, tests in `apps/web/test/security.test.ts` and `ownership-and-flows.test.ts`. | Same helpers. New audit actions (`automation.settings_updated`, `automation.run_started/completed`, `application.execution_started/failed`, `provider.connected/disconnected/auth_failed`, `candidate_answer.saved/deleted`, …). Every new table carries `userId` and cascades on user deletion. Gap: `accountService.export` does not include the new personal-data tables yet (section 8). |
| R44 | Provider session management (encrypted tokens, expiry → NEEDS_ATTENTION, no silent retries) | NEW | The pattern exists for mailbox feeds only: `JobFeed.secretEnc`, `describeError(...).needsAttention` → `NEEDS_ATTENTION`, `nextSyncAt: null` (no retry), one notification, reconnect in place. | `ProviderConnection` (`secretEnc`, `status`, `expiresAt`, `lastCheckedAt`, `lastError`, `consecutiveFailures`, non-secret `metadata`) + `providerConnectionsService.connect / disconnect / credentialFor / markAuthFailed / statusFor`. `SubmissionResult.AUTH_FAILED` → `NEEDS_ATTENTION`, nothing retried, user notified. Tokens decrypted only for one call (`SubmissionPayload.credential`), never returned to the client or logged. Job-platform passwords and cookies are never stored. |
| R45 | Demo mode (100+ jobs, duplicates, scripted outcomes) | EXTEND | 32 fictional `DEMO_JOBS` (`packages/job-engine/src/demo/jobs.ts`) seeded into the shared catalogue (`seedDemoJobs`, `ownerUserId: null`, never merged); mock ATS pages `/demo/ats/[platform]/[slug]` ("Submitting does nothing"); demo user in `prisma/seed.ts`; admin reset behind `ENABLE_DEMO_ADMIN` (non-production). | Demo provider (`packages/job-engine/src/providers/demo.ts`, DEMO CONTENT): `generateDemoAutomationJobs` produces 100+ deterministic private jobs across simulated providers, including cross-provider duplicates, with `DEMO_SCENARIOS` driving outcomes (captcha, login, unknown question, interview, rejection, …). Imported through a `JobFeedKind.DEMO` feed so the real merge, rules, executors and email classifier run. `DEMO_PROVIDER_ENABLED` gates it in production. |
| R46 | Tests | EXTEND | Vitest per package (matching, taxonomy, questionnaire, connectors, feeds, claim validator, workflows, confirmation, mail sources, resume engine, validation) and DB-backed web tests on `applywise_unit` (`QUEUE_DRIVER=inline`, `AI_DISABLED=true`). | New pure-module suites (rules, questions/answers, resume selection, status-email classifier, provider registry capabilities, extended state machine) and DB-backed suites (CAS transitions under concurrency, daily-limit reservations under concurrency, execution idempotency across merged duplicates and retries, lease recovery, notification dedupe and quiet hours, provider auth failure, ownership of every new endpoint, no PII in logs). DB tests must create uniquely named users and never truncate the shared database. |
| R47 | E2E acceptance | REFACTOR | Nine Playwright specs; `07-no-auto-submit.spec.ts` scans `apps/web/src`, `apps/extension/src` and `packages` for `.submit(`, `.requestSubmit(` and `.click(` and fails on any hit. | The scan conflicts with the worker-side browser executor and must be narrowed, not deleted (section 5.2). New acceptance flow with the demo provider: enable automation → run → 100+ jobs with merged duplicates → decisions → review queue → approve → executor applies → daily limit respected → CAPTCHA scenario ends in `MANUAL_ACTION_REQUIRED` with a handoff → status email moves the application to INTERVIEW. |
| R48 | Documentation | EXTEND | `README.md`, `docs/architecture.md`, `api.md`, `job-sources.md`, `platform-integration-policy.md`, `privacy-and-compliance.md`, `running-guide.md`, `setup.md`, `implementation-plan.md`. | New: `AUTOMATION_ARCHITECTURE.md`, this document. Required updates to the existing documents are listed in section 8 (several currently state that nothing is ever submitted). |

### 2.9 Sources: discovery and automatic application

Baseline discovery channels come from `docs/job-sources.md`, `packages/job-engine/src/feeds/*` and
`packages/job-engine/src/connectors/*`. Target statuses are the ones decided in `AUTOMATION_ARCHITECTURE.md`
("Providers and capabilities"); they were not validated against the live providers in this analysis.

| Source | Discovery: baseline | Discovery: target | Auto-apply: baseline | Auto-apply: target | Why |
| --- | --- | --- | --- | --- | --- |
| LinkedIn | Job-alert emails (sender rule in `feeds/alerts/senders.ts`, fixtures `linkedin-*.html`); extension import of a page the user opened | LIMITED (alerts) — EXISTS | None; listed in `UNSUPPORTED_INTEGRATIONS` | **EXTERNAL_LIMITATION** | No public job/apply API; the baseline policy forbids automated LinkedIn activity of any kind |
| Indeed | Alerts (`indeed-digest.*`); CSV; extension | LIMITED — EXISTS | None; "requires publisher/partner agreement" | **EXTERNAL_LIMITATION** | Indeed Apply is partner-only; would become REQUIRES_EXTERNAL_CONFIGURATION only with a signed partner agreement |
| Naukri | Alerts (`naukri-*.html`, `naukri-forwarded.eml`); extension | LIMITED — EXISTS | None; "requires an approved partnership" | **EXTERNAL_LIMITATION** | Partner agreement needed; login-walled |
| Foundit | Alerts (`foundit-*.html`) | LIMITED — EXISTS | None | **EXTERNAL_LIMITATION** | No candidate-side API |
| Wellfound | Alerts (`wellfound-*.html`) | LIMITED — EXISTS | None | **EXTERNAL_LIMITATION** | No candidate-side API |
| Instahyre | Alerts (`instahyre-*.html`) | LIMITED — EXISTS | None; "no approved partner API configured" | **EXTERNAL_LIMITATION** | No candidate-side API |
| Glassdoor, Cutshort, Hirist / iimjobs | Alerts (fixtures for each) | LIMITED — EXISTS | None | **EXTERNAL_LIMITATION** | No candidate-side API |
| Greenhouse | Public job-board API (`feeds/boards/greenhouse.ts`); extension prefill adapter | AVAILABLE — EXISTS | None (prefill of selected fields only) | **REQUIRES_EXTERNAL_CONFIGURATION** for the official submission API (employer's key); EXPERIMENTAL browser executor behind `BROWSER_EXECUTOR_PROVIDERS` | Stops on CAPTCHA / login; otherwise manual handoff |
| Lever | Public postings API (`feeds/boards/lever.ts`); extension adapter | AVAILABLE — EXISTS | None | Same as Greenhouse | Same |
| Ashby | Public job-board API (`feeds/boards/ashby.ts`); extension adapter | AVAILABLE — EXISTS | None | Same as Greenhouse | Same |
| SmartRecruiters, Workable, Recruitee | Public board APIs (`feeds/boards/*`) | AVAILABLE — EXISTS | None | **REQUIRES_EXTERNAL_CONFIGURATION** → manual handoff | Official submission needs employer credentials |
| Workday | Not supported: `detectUnsupportedPortal` advises alerts; extension prefill adapter only | NOT_SUPPORTED — EXISTS (advice) | None | **EXTERNAL_LIMITATION** | Per-employer tenants and accounts, no public API |
| Company career sites | `careerPageUrlConnector` (URL + pasted description, page not fetched); extension import | LIMITED — EXISTS | None | MANUAL (handoff) | No generic, permitted submission channel |
| Search APIs (Adzuna, Himalayas, Jobicy, The Muse) | `feeds/search/*`; Adzuna needs `ADZUNA_APP_ID/KEY` | AVAILABLE, or NOT_CONFIGURED without a key — EXISTS | None; apply links go to the provider's page | MANUAL | These APIs do not accept applications |
| Job-alert emails (Gmail / Outlook / IMAP / forwarding) | `packages/mail-sources`, `feeds/alerts`, signed inbound webhook | AVAILABLE — EXISTS | n/a | n/a; also a source for status tracking (R41) — NEW | — |
| Email applications (HR address) | n/a | n/a | Per-application confirmed send (`sendConfirmedEmail`) | SUPPORTED only when the email provider delivers, `allowEmailApplications` is on (default off) and the consents hold — EXTEND | Invariant change, section 5.4 |
| Demo provider | 32 static catalogue jobs | AVAILABLE — NEW (100+ jobs) | Mock ATS pages; nothing sent | SUPPORTED (API and browser executors, DEMO CONTENT) — NEW | Needed to demonstrate and test the whole pipeline |

---

## 3. Database migration plan

Migration: `packages/database/prisma/migrations/20260927120000_automation_orchestration/migration.sql` (applied; the
Prisma client is generated). It is **purely additive**: no `DROP`, no `RENAME`, no column type change, no data
`UPDATE`, and every `NOT NULL` column added to an existing table has a default.

### 3.1 What it adds

**New enum types (11):** `ApplicationMode`, `AutomationDecision`, `ManualActionReason`, `ApplicationOrigin`,
`ExecutorKind`, `ExecutionStatus`, `AutomationRunStatus`, `ProviderConnectionStatus`, `ProviderAuthType`, `AnswerSource`,
`ApplicationMessageCategory`.

**Values added to existing enums:**

- `ApplicationStatus` + 12: `DISCOVERED`, `MATCHING`, `MATCHED`, `REJECTED_BY_RULES`, `NEEDS_INFORMATION`,
  `WAITING_APPROVAL`, `AUTO_ELIGIBLE`, `APPLYING`, `APPLIED`, `FAILED`, `MANUAL_ACTION_REQUIRED`, `ASSESSMENT`.
- `ConsentType` + `AUTO_APPLY`.
- `JobFeedKind` + `DEMO`.

**New tables (9):**

| Table | Key constraints | On user deletion |
| --- | --- | --- |
| `AutomationSettings` | unique `userId`; index `(enabled, nextRunAt)`; defaults `enabled=false`, `mode=MANUAL`, scores 50/70/90, 10 per day, 14 days, 360 min, `allowEmailApplications=false`, time zone `Asia/Kolkata` | cascade |
| `AutomationRule` | unique `userId`; empty filter arrays, `requiredSkillsMode='any'`, `locationMode='preferences'`, `maxExperienceGapYears=1` | cascade |
| `AutomationRun` | index `(userId, startedAt)`, `(status)` | cascade |
| `AutomationRunItem` | index `(runId, createdAt)`, `(applicationId)`; FK only to `AutomationRun` | cascade via the run |
| `ApplicationExecution` | unique `idempotencyKey`; index `(applicationId)`, `(userId, status)`, `(status, leaseUntil)` | cascade (user and application) |
| `DailyApplicationCounter` | primary key `(userId, day)` | cascade |
| `ProviderConnection` | unique `(userId, provider)`; index `(status)` | cascade |
| `CandidateAnswer` | unique `(userId, questionKey)`; FK to `CandidateProfile` | cascade (user and profile) |
| `ApplicationMessage` | unique `(userId, messageHash)`; index `(applicationId)`, `(userId, receivedAt)`; `applicationId` FK `SET NULL` | cascade |

**New columns on existing tables:**

| Table | Columns | Existing rows get |
| --- | --- | --- |
| `Application` (27) | `appliedAt`, `approvalSource`, `automationDecision`, `automationRunId` (FK → `AutomationRun`, `SET NULL`), `canonicalJobKey`, `decisionReasons` (`'[]'`), `decisionScore`, `evaluatedAt`, `executorId`, `executorKind`, `externalApplicationId`, `failureReason`, `lastStatusSyncAt`, `manualActionDetail`, `manualActionReason`, `mode`, `nextActionAt`, `origin` (`'USER'`), `pendingQuestions` (`'[]'`), `preparedAt`, `resumeSelectionOverridden` (`false`), `resumeSelectionReason`, `resumeSelectionScore`, `rulesVersion`, `selectedResumeId` (FK → `Resume`, `SET NULL`), `selectedResumeVersionId`, `skippedUntil` | `origin=USER`, `mode=NULL`, empty JSON arrays, `false`, all other columns `NULL` |
| `ApplicationEvent` | `actor` (`'user'`) | `actor='user'` |
| `Notification` | `dedupeKey` + unique index `(userId, dedupeKey)` | `NULL` (PostgreSQL treats NULLs as distinct, so existing rows cannot collide) |
| `Resume` | `label`, `targetRoles` (`{}`) | `NULL`, `{}` |
| `ScreeningAnswerDraft` | `answerSource` (`'GENERATED'`), `questionKey`, `required` (`false`), `resolved` (`true`) | `GENERATED`, `NULL`, `false`, `true` |

New indexes on `Application`: `(userId, canonicalJobKey)`, `(userId, automationDecision)`, `(automationRunId)`,
`(status, nextActionAt)`.

Soft references (no foreign key, by design or pending): `Application.selectedResumeVersionId`,
`AutomationRunItem.userId / jobId / applicationId`, `CandidateAnswer.truthBankItemId`.

### 3.2 Why existing data is unaffected

- Existing applications keep their status and all baseline columns; the manual flow's transitions are unchanged in
  `application-state.ts`, and `origin=USER` marks them as user-created.
- Nothing is enabled for anyone: no `AutomationSettings` row exists until a user opens the control centre (and its
  defaults are `enabled=false`, `mode=MANUAL`); no `AUTO_APPLY` consent exists; the browser executor is off by default.
- Enum values were added with `ALTER TYPE … ADD VALUE` and are not used as defaults in the same migration, which is what
  allows it to run inside one migration on PostgreSQL 12+ (the project uses `postgres:16-alpine`; the Prisma-generated
  warning in the SQL concerns PostgreSQL 11 and earlier).
- New tables hold personal data only with a `userId` and `ON DELETE CASCADE`, so account deletion keeps working.

### 3.3 Data caveats to handle in code (not bugs in the migration)

1. **Legacy screening drafts look resolved.** Existing `ScreeningAnswerDraft` rows get `resolved=true`, `required=false`,
   including the baseline placeholder answers ("I cannot confirm this … [Please answer this question yourself …]",
   `canConfirm=false`). No executor may send drafts prepared before the migration; they must be re-prepared (or treated as
   unresolved when `questionKey IS NULL AND canConfirm = false`). **Open at the time of writing:** `buildPayload` in
   `application-execution.service.ts` selects drafts `where resolved = true`, and `applicationService.applyNow` gives a
   legacy application (`mode=NULL`) `mode=REVIEW` and approves a `READY_FOR_REVIEW` one without re-running preparation,
   so a user's "Approve & apply" on a pre-migration application would send those placeholders. Fix options: re-prepare in
   `applyNow` when `preparedAt IS NULL`, or exclude `canConfirm = false` drafts with a `NULL` `questionKey` in `buildPayload`,
   or a data migration `UPDATE "ScreeningAnswerDraft" SET "resolved" = "canConfirm" WHERE "questionKey" IS NULL`.
2. **Legacy approvals are not automation approvals.** Existing `APPROVED` applications have `mode=NULL` and no
   `approvalSource`; the user approved them expecting to apply themselves. `applicationExecutionService.execute` already
   skips any application whose mode is not REVIEW or AUTO, and `redriveDeferred` filters on the same modes, so they are
   never picked up automatically; only an explicit "Approve & apply" (`applyNow`) can opt one in (see item 1).
3. **No canonical key on legacy rows.** `canonicalJobKey` is `NULL` for existing applications. The execution service
   already derives it from the job when the column is empty (`app.canonicalJobKey ?? canonicalJobKey(app.job)`), and
   `applicationService.getOrCreate` backfills it lazily. **Open at the time of writing:** the orchestrator's
   `alreadyApplied` check counts applications `where canonicalJobKey = <key>` in a sent status, so a legacy `SUBMITTED` /
   `EMAIL_SENT` application that is never touched again does not block an automated application for a *different* `Job`
   row of the same role (possible once the original job is older than the 60-day merge window). Fix: a one-off backfill,
   e.g. `UPDATE "Application" a SET "canonicalJobKey" = COALESCE(j."matchKey", 'dedupe:' || j."dedupeKey") FROM "Job" j
   WHERE a."jobId" = j."id" AND a."canonicalJobKey" IS NULL` (same formula as `canonicalJobKey()` in `provider-job-ref.ts`).
4. **Historical actors.** Baseline events written by background tasks (e.g. "Drafts ready for your review") are labelled
   `actor='user'`; acceptable because every baseline transition followed a user action, but the UI should not present the
   actor of pre-migration events as authoritative.

### 3.4 Rollout

1. `pnpm --filter @applywise/database db:deploy` (`prisma migrate deploy`), before deploying code.
2. Deploy the web app and the worker (`pnpm --filter @applywise/web worker`) with `AUTOMATION_SCHEDULER`, queue driver and
   `BROWSER_EXECUTOR_*` settings; keep the browser executor off until the demo acceptance flow passes.
3. Users opt in per account (enable automation, choose a mode, grant AUTO_APPLY for AUTO).

### 3.5 Rollback

Prisma has no down migrations; rollback is manual.

- **Preferred: code rollback, schema kept.** The old code ignores the new tables and columns, but the old generated
  Prisma client cannot read rows whose enum columns hold values it does not know. Before switching back: stop the
  worker and let running executions finish (or their leases expire), then map `Application.status`,
  `ApplicationEvent.fromStatus` and `ApplicationEvent.toStatus`, for example: `DISCOVERED` / `MATCHING` / `MATCHED` /
  `REJECTED_BY_RULES` / `AUTO_ELIGIBLE` → delete the `origin=AUTOMATION` application (or `SAVED`); `WAITING_APPROVAL` /
  `NEEDS_INFORMATION` → `READY_FOR_REVIEW`; `APPLYING` / `FAILED` / `MANUAL_ACTION_REQUIRED` → `APPROVED` if `approvedAt`
  is set, else `READY_FOR_REVIEW` (and tell the user to check whether anything was sent); `APPLIED` → `SUBMITTED`
  (`submittedAt = appliedAt`); `ASSESSMENT` → `INTERVIEW`. Delete `UserConsent` rows of type `AUTO_APPLY` and `JobFeed`
  rows of kind `DEMO` (their demo jobs first: `Job.feedId` is `SET NULL` on feed deletion).
- **Full schema rollback** (only if required): export the new tables first (runs, executions, answers, messages are
  lost otherwise), apply the mapping above, drop the new foreign keys, the 9 tables, the new columns and the 11 new enum
  types; remove the added enum values by recreating `ApplicationStatus`, `ConsentType` and `JobFeedKind` (create the old
  type under a new name, `ALTER COLUMN … TYPE … USING col::text::<new type>` for every column of that type, drop the
  extended type, rename); finally delete the migration's row from `_prisma_migrations`.

### 3.6 Later migrations (added after this plan)

| Migration | What it does | Existing rows get |
| --- | --- | --- |
| `20260927130000_automation_backfill` | Data only (no schema change): fills `Application.canonicalJobKey` for legacy rows and sets `resolved = canConfirm` on screening drafts without a `questionKey` (the caveats of 3.3; see 10.3) | as described |
| `20260927140000_automation_hardening` | Additive: `AutomationSettings.runLeaseRunId` (`TEXT`, nullable: the `AutomationRun` that owns the run lease; only its owner renews or releases it) and `Application.runtimeQuestions` (`JSONB NOT NULL DEFAULT '[]'`: questions an executor found on the live form, merged into the next preparation so the user's answers reach the payload) | `runLeaseRunId = NULL`, `runtimeQuestions = '[]'` |

Rollback of the hardening migration: drop the two columns (the old code does not read them).

---

## 4. Truth-model impact (summary)

Automation adds no new source of truth. The only values an executor may send are: user-entered profile and preference
fields, verified TruthBank facts and skills, the user's previous questionnaire answers, user-authored `CandidateAnswer`
rows, and generated text whose claims cite verified facts and pass `validateClaims`. Salary, notice period, work
authorisation, visa status, relocation and start date are never generated. Unknown stays unknown: the application stops
at `NEEDS_INFORMATION` (before or during execution) and the answer the user gives is stored for reuse.

---

## 5. Existing invariants that change

The baseline was built on one explicit rule: **nothing is ever submitted for the user**. It is stated in
`README.md` ("ApplyWise never submits an application for you", "There is no code path that submits an application
form"), `docs/implementation-plan.md` ("Safety by construction: no code path submits third-party forms"),
`docs/platform-integration-policy.md` (prohibits "Unattended or bulk submission: auto-clicking final submit,
programmatic `form.submit()` / `requestSubmit()`, or sending applications without the user's per-application review and
approval"), `docs/job-sources.md` ("nothing is ever submitted for you"), the state-machine header ("Nothing reaches
SUBMITTED or EMAIL_SENT automatically"), and it is **enforced by `apps/web/e2e/07-no-auto-submit.spec.ts`**, which fails
if any non-test source file under `apps/web/src`, `apps/extension/src` or `packages` contains `.submit(`,
`.requestSubmit(` or `.click(` (except the `<a download>` helper).

The new design replaces "never" with "only here, only under these conditions", and keeps the old rule everywhere else.

### 5.1 Where the old invariant still holds unchanged

| Surface | Guarantee | How it is kept |
| --- | --- | --- |
| Browser extension | Never submits, never clicks, no content scripts, fills only fields the user selected | `eslint.config.js` is unchanged from the baseline (verified by diff), so the `no-restricted-syntax` ban on `.submit()`, `.requestSubmit()` and `.click()` still applies; the extension only gained pure handoff helpers and screening-answer label matching (no match for `.submit(`, `.requestSubmit(` or `.click(` in `apps/extension/src`) |
| Web UI (pages, client components, `/api` routes) | Never contacts a job provider or submits a form; can only approve, decline, answer questions, override the resume, or request a retry | Approval moves the application to `APPROVED` and enqueues `application.execute`; nothing browser-side performs the submission |
| MANUAL mode (the default) | Behaves exactly like the baseline: prepare → `READY_FOR_REVIEW` → the user applies | `AutomationSettings` defaults `enabled=false`, `mode=MANUAL` |
| User-declared submission | `SUBMITTED` only via `mark_submitted`; `EMAIL_SENT` only via the confirmed send endpoint | Unchanged transitions; automated sends end in the separate `APPLIED` state, so provenance stays visible |
| Manual tracker | Cannot set APPROVED, APPLYING, APPLIED, SUBMITTED, EMAIL_SENT or AUTO_ELIGIBLE | `track` targets in `application-state.ts` |

### 5.2 The one place submission is allowed

Submission happens **only** inside the worker, in `applicationExecutionService.execute`, through an executor in
`apps/web/src/server/services/executors`, and only when all of these hold:

1. REVIEW mode with an explicit user approval, or AUTO mode with rule decision `AUTO_ELIGIBLE`, the `AUTO_APPLY` consent,
   automation enabled, truth validation passed, every required question resolved from verified data, not quiet hours,
   and no known manual challenge (`APPROVED` via `policy_approve` is only possible from `PREPARING`).
2. The provider supports submission and an automatic executor is available (`supportsApplication`, operator flags,
   connection status); otherwise `MANUAL_ACTION_REQUIRED` with a reason and a handoff package.
3. The idempotency claim on `userId:canonicalJobKey` is won (`ApplicationExecution.idempotencyKey` unique; `SUCCEEDED`
   terminal).
4. A daily-limit slot is reserved atomically (`dailyLimitService.reserve`).
5. The CAS transition `APPROVED → APPLYING` is won (`transitionApplication`).
6. The executor stops, and never works around, CAPTCHA, MFA, login walls and unknown required questions.

**Required change to the E2E guard (not a removal).** The browser executor needs Playwright interactions (e.g.
`locator.click()`), which the current regex scan would reject. The spec should: keep scanning `apps/extension/src`,
`packages` and all of `apps/web/src` **except** `apps/web/src/server/services/executors/`; additionally assert that only
`application-execution.service.ts` imports from `executors/`, that no `"use client"` module and no `app/api` route imports
it, and that no API route can move an application to `APPLYING` or `APPLIED`. The existing checks (no endpoint marks an
application submitted or sends email without explicit confirmation; extension prefill never submits a real form) stay
as they are.

### 5.3 Headless browsers

The baseline policy lists headless browsers under prohibited **scraping**. The new executor uses headless Chromium
**for submission only**, in the worker, never for discovery or reading pages the user did not ask for, off by default,
limited to `BROWSER_EXECUTOR_PROVIDERS` (default `demo`), with a dry-run mode, no stealth or fingerprint evasion, and
never on LinkedIn, Indeed, Naukri or other sites whose terms forbid automation. `platform-integration-policy.md` must be
amended to say exactly this.

### 5.4 Email applications

Baseline: an application email can only be sent after the user previews it and confirms within 15 minutes; the HMAC
token is bound to a digest of the exact message (`emailService.preview` / `requestSend` / `runSend`). Target: the
`api:email` executor may send HR-address applications when `allowEmailApplications` is on (default off), the
`EMAIL_SENDING` and (for AUTO) `AUTO_APPLY` consents are granted and the address is verified. `sendConfirmedEmail` must
remain the only send path and the digest binding must be kept; the "confirmation" becomes the user's approval (REVIEW) or
the standing consent plus policy (AUTO), and the event/audit entry must say so (`actor` = `policy` / `executor`).

### 5.5 Mailbox scope and stored metadata

Baseline privacy promise: only emails from known job-alert senders are downloaded, and subjects are never stored
(`docs/privacy-and-compliance.md`). Status tracking needs employer / ATS replies and stores a truncated subject, the
sender domain and a message-id hash (`ApplicationMessage`). This must be an explicit opt-in for mailbox-based tracking
(forwarding and the demo provider need no widening), and the privacy document must be updated.

### 5.6 Credentials

The baseline forbids storing a user's password, cookies or session for any job platform. `ProviderAuthType` includes
`SESSION_TOKEN`, which no code uses today. It must not be used to hold third-party job-platform session cookies; either
document a permitted use (a token issued by a provider's documented API) or remove the value in a later migration.

---

## 6. Duplicate systems avoided

| Concern | The one system | What was *not* built |
| --- | --- | --- |
| Matching | `computeMatchReport` / `recomputeMatchScores` (`JobMatchScore`) | No automation score. The rule engine reads `RuleMatchInput` from the report ("never recomputes the score"); resume selection ranks resume variants for one job, it does not score job fit. |
| Job model | `Job` + `JobSource` via `persistNormalizedJob` | No "discovered job" table. Providers wrap the existing adapters and import through `jobsService.importRaws`; the demo provider uses a `JobFeedKind.DEMO` feed, so the real merge runs on its duplicates. |
| Source runs | `JobFeed` / `JobFeedRun` for sources; `AutomationRun` aggregates | Per-provider run details reuse feed counts (`AutomationRunProviderDetail.feedId`) instead of a second sync log. |
| Queue | `apps/web/src/server/queue` (`enqueue`, `BackgroundTask`, inline / memory / BullMQ) | No second job runner; the worker process consumes the same BullMQ queues; a new `apply` lane instead of a new queue system. |
| State machine | `apps/web/src/server/domain/application-state.ts` + `transitionApplication` | No execution-specific status on `Application`; `ApplicationExecution.status` tracks attempts, `Application.status` stays the single lifecycle. |
| Notifications | `Notification` + `notificationService.notify` | No separate automation alert channel; dedupe and quiet hours live in the one service. |
| Question classification | `classifyQuestion` in `packages/job-engine/src/automation/questions.ts` | Answer resolution (`candidateAnswersService.answerSources` → `resolveApplicationAnswers`) and the browser executor use the same classifier and the same `questionKey`s (`SubmissionPayload.answers[].key`), so a question answered once is recognised on every form. The extension's `form-match.ts` label matcher is not a second resolver: it only matches page labels to answers the server already resolved and sends with their classifier `key` (`PrefillAnswer.key`); it never decides an answer. |
| Truth and AI | TruthBank + `validateClaims` + `packages/ai` workflows | No automation-specific generator or validator. |
| Email sending | `sendConfirmedEmail` (`packages/email`) | No second SMTP path for automated email applications. |
| Mailbox access | `packages/mail-sources` (IMAP, Gmail API, Microsoft, forwarding webhook) | Status tracking reuses it instead of a new mail client. |
| Security helpers | `server/crypto.ts`, `server/logger.ts`, `server/audit.ts`, ownership helpers | Provider tokens reuse `encryptText`; new audit actions extend `AuditAction`. |

---

## 7. Risks and open questions

| Risk | Mitigation in the design | Still open |
| --- | --- | --- |
| Duplicate submission after a crash mid-submit | `ApplicationExecution.leaseUntil`, `idempotentSubmission`, `SUBMISSION_UNCERTAIN` handoff | Behaviour for executors without provider-side dedupe depends on the user checking |
| Submitting twice to the same role found via two providers | `canonicalJobKey` from `Job.matchKey` | Jobs whose `matchKey` is `NULL` (unknown company) or older than the 60-day merge window are not recognised as the same role |
| Legacy rows treated as automation-ready | Execution skips `mode` other than REVIEW / AUTO; canonical key derived from the job at execution | Legacy placeholder screening answers on "Approve & apply"; legacy sent applications invisible to `alreadyApplied` (section 3.3 items 1 and 3) |
| ATS forms change or add anti-bot checks | Browser executor is EXPERIMENTAL, off by default, stops on challenges | Not validated against live Greenhouse / Lever / Ashby forms |
| Email applications without per-message preview | Off by default, consents, digest binding | Exact confirmation semantics (section 5.4) |
| Mailbox scope widening | Metadata-only storage | Opt-in UX and privacy text (section 5.5) |

---

## 8. Follow-ups outside this document

These were found during the analysis and are outside the scope of this file:

1. `apps/web/e2e/07-no-auto-submit.spec.ts`: narrow the scan as described in section 5.2 (keep it; exempt only
   `apps/web/src/server/services/executors/`; add the import-boundary assertions).
2. (Resolved during the analysis by the extension workstream: prefill for `MANUAL_ACTION_REQUIRED` / `FAILED` with
   classifier-keyed answers in `extension.service.ts`.)
3. `apps/web/src/server/services/account.service.ts`: include `AutomationSettings`, `AutomationRule`, `AutomationRun`
   (+ items), `ApplicationExecution`, `CandidateAnswer`, `ApplicationMessage` and `ProviderConnection` (without
   `secretEnc`) in the export; revoke provider tokens on deletion where the provider supports it.
4. `application.service.ts applyNow` / `application-execution.service.ts buildPayload`: never send pre-migration
   screening drafts (section 3.3 item 1). Backfill `Application.canonicalJobKey` for legacy rows so the orchestrator's
   `alreadyApplied` check sees them (section 3.3 item 3). The mode guard (item 2) was already in place when this was
   written.
5. Migrate the 4 direct `prisma.notification.create` call sites (`application.service.ts`, `job-feeds.service.ts`) to
   `notificationService.notify` with dedupe keys.
6. Documentation: amend `README.md`, `docs/platform-integration-policy.md` (sections 5.2–5.6), `docs/privacy-and-compliance.md`
   (status-email metadata, AUTO_APPLY consent, provider tokens), `docs/job-sources.md` ("nothing is ever submitted"),
   `docs/architecture.md` (state machine, worker, lanes), `docs/api.md` (new endpoints) and `docs/running-guide.md`
   (worker process, Chromium, `AUTOMATION_*` / `BROWSER_EXECUTOR_*`).

---

## 9. Verification

How the claims above were checked (2026-09-27):

- Extracted the baseline archive into the session scratchpad (`tar -xf baseline.tar`) and counted files
  (`find . -type f -not -path '*/node_modules/*' | wc -l` → 440).
- Read the baseline schema (`packages/database/prisma/schema.prisma`), state machine, queue (`queue/index.ts`,
  `handlers.ts`), `application.service.ts`, `job-feeds.service.ts`, `email.service.ts`, `extension.service.ts`,
  `questionnaire.service.ts`, `resume.service.ts`, `profile-import.ts`, `candidate.ts`, `jobs.ts`, `consent.service.ts`,
  `audit.ts`, `logger.ts`, `ownership.ts`, `instrumentation-node.ts`, the extension (`form-match.ts`, `adapters.ts`,
  `eslint.config.js`) and the baseline docs.
- Absence checks on the baseline (no hits outside tests for any of these):
  `grep -rlin -e "AutomationSettings" -e "AUTO_APPLY" -e "ApplicationMode" -e "idempotency" -e "NEEDS_INFORMATION" -e "MANUAL_ACTION" -e "selectedResume" -e "CandidateAnswer" -e "ProviderConnection" -e "submitApplication" apps packages`;
  `playwright|chromium` matched only `apps/web/e2e/*.spec.ts`.
- `grep -rn "yearsUsed"` (read-only uses), `grep -rn "notification.create"` (4 call sites),
  `grep -c 'key: "' packages/job-engine/src/demo/jobs.ts` (32 demo jobs),
  `grep -n "dedupeKey" apps/web/src/server/queue/index.ts` (BullMQ only).
- Migration facts from `packages/database/prisma/migrations/20260927120000_automation_orchestration/migration.sql`
  (enums, tables, columns, defaults, indexes, foreign keys) and the current `schema.prisma` (soft references).
- `diff -q` of `apps/extension/eslint.config.js` and `apps/web/e2e/07-no-auto-submit.spec.ts` against the baseline
  (both unchanged), `diff -rq apps/extension/src` (only `handoff.ts` added and prefill/answer matching extended), and
  `grep -rnE '\.(submit|requestSubmit|click)\s*\(' apps/extension/src` (no match); `docs/*.md` other than the two
  automation documents were unchanged from the baseline at the time of writing.
- Chosen modules checked in the current tree (`ls`, `grep -n "^export"`). They were being implemented in parallel while
  this was written, so implementation status is deliberately not tracked here; for the current state run
  `grep -l "not implemented" packages/job-engine/src/automation/*.ts packages/job-engine/src/providers/*.ts apps/web/src/server/services/*.ts`.
- Statements about current code in sections 2, 3.3, 7 and 8 (`canonicalJobKey()`, the mode guard in
  `applicationExecutionService.execute`, `redriveDeferred`, `applyNow`, `getOrCreate`, `buildPayload`, the orchestrator's
  `alreadyApplied` query and decision-to-status mapping, `truthOk` in `runPrepare`, `PREFILL_STATUSES`) were read from
  the current tree at the end of the analysis (`grep -n "mode\|resolved\|canonicalJobKey" application-execution.service.ts`,
  `sed -n` on the relevant functions).

---

## 10. Implementation status

Recorded after the automation layer was implemented (2026-09-27), by reading the current tree (see 10.6). Status values:

| Status | Meaning |
| --- | --- |
| **DELIVERED** | Implemented as decided in section 2 (differences are noted). |
| **PARTIAL** | Implemented, with the named part still open. |
| **UNCHANGED** | Baseline behaviour reused as decided (EXISTS rows). |
| **EXTERNAL_LIMITATION** | Cannot be delivered honestly (terms, missing candidate-side APIs, login walls). |
| **REQUIRES_EXTERNAL_CONFIGURATION** | Works only with an agreement, credential or operator setup ApplyWise does not ship. |

### 10.1 Requirements

| # | Status | Delivered (evidence) | Remaining |
| --- | --- | --- | --- |
| R1 | DELIVERED | `ConsentType.AUTO_APPLY`, consent key `autoApply` (`PATCH /api/consents`, `autoApplyConsent` in `PUT /api/automation/settings`); readiness blocker; `applicationExecutionService.execute` re-checks automation, AUTO mode, the consent, the unchanged `rulesVersion`, the decision's freshness (`automationDecisionIsStale`) and a daily limit above 0 for policy approvals, and returns a blocked one to `WAITING_APPROVAL` with a review notification; the email executor needs `EMAIL_SENDING` and a verified address | — |
| R2 | UNCHANGED | Profile and preferences are the resolver's first sources (`candidateAnswersService.answerSources`); work authorisation, visa, start date, current salary and current location come only from the user's own answers (the profile's location source is always empty: preferred locations are not the current city) | Years of experience, current title and current company may come from the CV parse when the user left them empty (editable in onboarding / profile; overlapping roles are merged before summing) |
| R3 | DELIVERED | Truth gate `truthOk` in `runPrepare`: the tailored resume **and** the cover letter's cited claims must have zero unsupported claims, and no answer may have been drafted by the generator, else `WAITING_APPROVAL` (`policyBlockers` in `application-routing.service.ts`); unsupported-claim count in `ReviewQueueItem.tailored` | — |
| R4 | DELIVERED | "Years with X" resolves from a verified skill's `yearsUsed` when present, else a user answer, else UNKNOWN | Nothing in the product writes `CandidateSkill.yearsUsed` yet |
| R5, R6 | UNCHANGED | Parsing and versions reused; the executor sends a rendered PDF of the approved `TAILORED` version, else the selected base version | — |
| R7 | DELIVERED | `Resume.label`, `Resume.targetRoles`; `PATCH /api/profile/resume/[resumeId]` (also labels resume versions without an uploaded file) | — |
| R8 | DELIVERED | `selectResume` (`resume-select-v1`) + `resumeSelectionService.rank / selectForApplication / override`; `GET/PUT /api/applications/[id]/resume`; review-queue and application-page override; overrides are never replaced | — |
| R9 | PARTIAL | Generator, validator and `buildTailoredDocument` kept; with `AutomationSettings.tailorResume=false` approval freezes the selected resume version when the user approved it (never the raw `ORIGINAL` CV parse), otherwise a resume built from verified facts; the executor renders only approved resume versions (`resumeFor`; none → manual handoff) | The tailoring base is still the verified profile document (`documentFromProfile`), not the selected resume; the tailoring plan is generated even when `tailorResume` is off |
| R10 | PARTIAL | Cover letters kept and now part of the truth gate (`validateClaims` on the cover letter's claims in `runPrepare`); `AutomationSettings.generateCoverLetter=false` is honoured for automation-created applications (no letter generated, an earlier one deleted, none in the payload or as an email attachment) | `ApplicationRequirements.acceptsCoverLetter` is not consulted; user edits to a cover letter are not re-validated (as in the baseline) |
| R11 | DELIVERED | `resolveQuestions`: resolver first, the guarded generator only for open, non-sensitive questions without options (max 8, only confirmed answers); a generated draft never resolves a required question, and an optional one blocks the Auto policy; the deterministic fallback never answers yes/no or threshold questions affirmatively; `ScreeningAnswerDraft.questionKey / answerSource / required / resolved`; `buildPayload` sends resolved answers only; unresolved required → `NEEDS_INFORMATION` | — |
| R12 | DELIVERED | `CandidateAnswer` + `candidateAnswersService`; `GET/PUT /api/candidate-answers`, `DELETE /api/candidate-answers/[id]`; Settings → Application answers; `POST /api/applications/[id]/answers` saves answers for reuse (or for one application with `remember: false`; a work-authorisation / sponsorship answer whose country is unknown is always stored for that application only) | — |
| R13 | DELIVERED | `classifyQuestion`, `collectApplicationQuestions`, `resolveApplicationAnswers` (`answers-v2`): work-authorisation / sponsorship keys carry the question's country, else the job's (`countryForLocations`), unrecognised phrases are never a country, and reusable answers are never used for a country-less key; a general relocation preference never answers a named destination; questions found on the live form (`Application.runtimeQuestions`) are resolved by the next preparation; the browser executor uses the same classifier and keys | A bare "Remote" location is normalised to "Remote - India", so country-less authorisation questions on such jobs are keyed to India |
| R14, R16, R18 | UNCHANGED | Ingestion, normalisation and matching reused; the orchestrator recomputes stale scores with `recomputeMatchScores` | — |
| R15 | DELIVERED | `JobFeedKind.DEMO`; runs call `jobFeedsService.claimDue` + `runSync`; the feeds tick skips users with automation on; a sync outside a run with new jobs makes the next run due | — |
| R17 | DELIVERED | `Application.canonicalJobKey`, `ApplicationExecution.idempotencyKey` (unique), rule check `already_applied` (sent/sending applications **or** a SUCCEEDED execution); duplicate listings are declined by the execution service | Roles whose `matchKey` is null or that are older than the 60-day merge window are still not recognised as the same role (risk in section 7) |
| R19-R21 | DELIVERED | `evaluateAutomationRules` (`rules-v1`) with every check of 2.3.1, plus: required skills on a snippet cap REVIEW instead of ignoring, unknown YOE / work mode / location / posting date cap REVIEW, whole-day job age (future dates count as today), salaries in another currency are not compared; decisions and checks stored on the application | — |
| R22 | DELIVERED | `JobProvider`, `catalog.ts` (environment-resolved statuses), `registry.ts`, `routing.ts`; Greenhouse question extraction (`providers/greenhouse.ts`) | Question extraction exists only for Greenhouse (and the demo provider) |
| R23 | DELIVERED | `apps/web/src/worker/main.ts` (`pnpm worker`, `WORKER_ROLES` - empty means the default -, health on `WORKER_HEALTH_PORT`, graceful shutdown: scheduler stopped, BullMQ workers and queues closed via `stopWorkers`, database disconnected within 25 s), `playwright-core`, `apply` lane (`APPLY_QUEUE_CONCURRENCY`), `BROWSER_EXECUTOR_*`; the browser executor re-checks the page URL against the adapter allowlist after every navigation, before fills and around submit, and blocks off-allowlist main-frame navigations | REQUIRES_EXTERNAL_CONFIGURATION: no container image; installing Chromium on the worker and running Redis are operator tasks. Residual: an HTTP 3xx redirect target off the allowlist is fetched with a GET before the flow stops (nothing is read, filled or submitted there) |
| R24 | DELIVERED | Executors `api:demo`, `api:email`, `browser:demo-ats`, `browser:greenhouse`, `browser:lever`, `browser:ashby`, `manual`; pure `selectExecutor`; only `applicationExecutionService.execute` runs them, and only for approved content (`approvedAt`, carried by every deferred task and required by the `APPROVED → APPLYING` compare-and-set); `idempotentSubmission` drives recovery; `api:email` only with a delivering email provider and a post that asks for applications to that address | The Greenhouse / Lever / Ashby adapters are EXPERIMENTAL and not validated against the live sites |
| R25 | DELIVERED | `ManualActionReason` + labels on `Application` and `ApplicationExecution`; `platform-integration-policy.md` amended (headless-browser clarification, "Automated applications" section) | — |
| R26 | DELIVERED | `ManualHandoffPackage` (`GET /api/applications/[id]/handoff`); `GET /api/extension/handoffs`; `PREFILL_STATUSES` = APPROVED (manual flow only), OPENED_APPLY_PAGE, MANUAL_ACTION_REQUIRED, FAILED; REVIEW/AUTO FAILED / MANUAL_ACTION_REQUIRED applications with an automatic retry scheduled are neither listed nor prefilled (`prefillBlockedReason`, checked when the code is issued and when it is resolved); prefill offers resolved answers only | — |
| R27 | DELIVERED | 25 states / 22 actions; `transitionApplication` (compare-and-set, with optional extra conditions such as an unchanged `approvedAt`) used by the application, orchestrator, routing, execution, tracking and email services; the manual email preview (`APPROVED → EMAIL_DRAFT_READY`) and send (`EMAIL_DRAFT_READY → EMAIL_SENT`, the confirmed preview consumed atomically) are compare-and-set, so an email is never sent twice; content edits clear the approval and are refused while APPLYING or once sent; the tracker cannot set the protected states | — |
| R28 | DELIVERED | `ApplicationEvent.actor` (user / system / policy / executor); `recordApplicationEvent` for non-status entries; messages capped at 500 characters | Pre-migration events keep `actor='user'` (3.3 item 4) |
| R29 | DELIVERED | `runPrepare` → `routeAfterPreparation` (READY_FOR_REVIEW / WAITING_APPROVAL / APPROVED by policy / NEEDS_INFORMATION / MANUAL_ACTION_REQUIRED); `preparedAt`, `nextActionAt` | — |
| R30 | DELIVERED | New tasks and handlers, `apply` lane, `apps/web/src/server/scheduler.ts` shared by the worker and `instrumentation-node.ts` (`AUTOMATION_SCHEDULER`, `AUTOMATION_TICK_SECONDS`) | — |
| R31 | DELIVERED | `automationOrchestrator.tick / schedulerTick / runNow / runForUser / resumeApplication / redriveDeferred / sweepLostExecutions / dailySummaryTick / dailySummary`; caps `AUTOMATION_MAX_JOBS_PER_RUN`, `AUTOMATION_MAX_PREPARE_PER_RUN`; the run lease is owned by the run (`runLeaseRunId`), renewed while it works and released only by its owner; stale RUNNING runs are closed as FAILED ("interrupted"); per-job evaluation errors are isolated; one preparation per canonical job across runs; strong-match notifications count only newly strong jobs; re-preparations are not counted on the original run; daily summaries page through every enabled user; scheduler steps are isolated and the in-process loop never overlaps itself | — |
| R32 | DELIVERED | All mechanisms of 2.6.2, plus the memory-driver dedupe set, suffixed execute keys for retries, deferrals, redrives, sweeps and user retries, approval stamps on deferred tasks, atomic outcome writes (execution row + application transition + slot release in one transaction), reconciliation of applications orphaned in APPLYING, and `SUBMISSION_UNCERTAIN` as a lock only the user's acknowledged retry lifts | — |
| R33 | DELIVERED | `DailyApplicationCounter` + `dailyLimitService.reserve / release / countToday`; `AUTOMATION_MAX_DAILY_LIMIT` caps the user setting | — |
| R34-R40 | DELIVERED | Pages `/automation`, `/automation/runs`, `/automation/runs/[runId]`, `/review`, `/settings/job-sources`, `/settings/answers`, `/dashboard` (`GET /api/dashboard/summary`), `/jobs` (decision filter, rule panel, "prepare anyway"), `/applications` (`?view=`, mode, executor, handoff, messages, event actors) | No Playwright E2E drives these pages (see R47) |
| R41 | PARTIAL | `classifyStatusEmail` / `associateStatusEmail` + `applicationEmailTrackingService.ingest`; employer emails reach it through the forwarding webhook (non-alert emails in `handleInbound`) and the demo provider's status sync; metadata-only `ApplicationMessage`; the catalog reports STATUS_TRACKING honestly: `job_alert_email` LIMITED (forwarding address only), every job board LIMITED (forwarded employer emails) | Connected IMAP / Gmail / Outlook mailboxes are not scanned for employer emails (sender filter unchanged, so no opt-in was needed) |
| R42 | DONE | `notificationService.notify` (dedupe key, quiet hours, `notification.dispatch`) used by every automation path and by the three `job-feeds.service.ts` notices (the daily "new matches" notice via `accumulate`, the Gmail forwarding confirmation and the needs-attention notice); dedupe keys are per episode (manual handoff per attempt, review per preparation, status per transition or message); `visibleNotificationsWhere` in `GET /api/notifications` | None: `applicationService.dispatchReminder` also uses the service (dedupe key per reminder time, quiet hours) |
| R43 | DELIVERED | New audit actions; every new table cascades on user deletion; `accountService.export` includes settings, rules, the latest 200 runs with items, executions, candidate answers, status-email metadata, daily counters and provider connections without `secretEnc` | — |
| R44 | DELIVERED | `ProviderConnection` + `providerConnectionsService.connect / disconnect / credentialFor / markAuthFailed / statusFor`; `PUT/DELETE /api/automation/providers/[providerId]/connection`; `SESSION_TOKEN` is never written; while a connection needs attention, approved applications for that provider are held (no per-application handoff notice) and `connect` re-queues them (`resumePausedForProvider`) | Connections are only used for `api_key` / `oauth_token` providers (today the demo provider); the endpoint also stores a token for providers with auth `none`, where it is never used |
| R45 | DELIVERED | 110 demo jobs + 14 cross-provider duplicate listings (`generateDemoAutomationJobs`), 12 scripted scenarios, `DEMO_PROVIDER_ENABLED`, `POST /api/automation/demo`, `pnpm demo:automation`, seed with resume variants, reusable answers and Auto-mode settings | The demo provider's simulated retry and submitted-application memory is per process (resets on restart, not shared between workers) |
| R46 | DELIVERED | Pure suites in `packages/job-engine/test` (`automation-rules`, `automation-questions`, `resume-selection`, `email-status`, `providers`, `demo-provider`) and DB-backed suites in `apps/web/test` (execution idempotency and concurrency, daily limit, orchestrator, settings, notifications, provider connections and sessions, candidate answers, email tracking, executors, extension handoff, job sources, state machine, resume selection) | — |
| R47 | DELIVERED (differently) | `07-no-auto-submit.spec.ts` narrowed as proposed in 5.2 and strengthened (inside `executors/browser/` the only click is `PlaywrightSession.submit()`, called once after the challenge, missing-field and dry-run checks); the acceptance flow is the service-level Vitest test `apps/web/test/automation-acceptance.test.ts` | No browser-level (Playwright) acceptance spec for the automation UI |
| R48 | DELIVERED | `README.md`, `architecture.md`, `api.md`, `running-guide.md`, `setup.md`, `job-sources.md`, `privacy-and-compliance.md`, `platform-integration-policy.md`, `implementation-plan.md`, `AUTOMATION_ARCHITECTURE.md`, `.env.example` updated | — |

### 10.2 Sources (section 2.9)

The capability statuses are resolved at runtime from `packages/job-engine/src/providers/catalog.ts`.

| Source | Discovery | Automatic application | Classification |
| --- | --- | --- | --- |
| LinkedIn, Indeed, Naukri, Foundit, Wellfound, Instahyre, Glassdoor, Cutshort, Hirist | LIMITED (job-alert emails) | manual handoff | **EXTERNAL_LIMITATION** (no candidate-side apply API, terms prohibit automation, login walls). Indeed or Naukri would move to REQUIRES_EXTERNAL_CONFIGURATION only with a signed partner agreement |
| Workday | NOT_SUPPORTED (alerts / extension import) | manual handoff | **EXTERNAL_LIMITATION** (per-employer tenants and accounts) |
| Greenhouse, Lever, Ashby | AVAILABLE (public board APIs); Greenhouse questions AVAILABLE | EXPERIMENTAL browser executor when the operator enables it; otherwise manual handoff | **REQUIRES_EXTERNAL_CONFIGURATION** for the official submission APIs (employer's key); the experimental adapters are not validated against the live sites |
| SmartRecruiters, Workable, Recruitee | AVAILABLE | manual handoff | **REQUIRES_EXTERNAL_CONFIGURATION** (employer credentials) |
| Company career sites | LIMITED (URL import, extension) | MANUAL | manual by design (no generic permitted channel) |
| Adzuna | AVAILABLE only with `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | MANUAL (provider's apply page) | **REQUIRES_EXTERNAL_CONFIGURATION** for discovery (operator key) |
| Himalayas, Jobicy, The Muse | AVAILABLE | MANUAL | delivered |
| Job-alert emails | AVAILABLE; Gmail / Outlook sign-in and the forwarding address need `GOOGLE_*`, `MICROSOFT_CLIENT_ID`, `INBOUND_EMAIL_*` | n/a (discovery channel) | app passwords delivered; OAuth and forwarding **REQUIRES_EXTERNAL_CONFIGURATION** (operator) |
| Email applications (HR address) | n/a | SUPPORTED only with a delivering provider (`smtp` + `SMTP_HOST` or `resend` + `RESEND_API_KEY`), the user's opt-in and a job post that asks for applications to that exact address; LIMITED with the dev outbox (manual handoff) | **REQUIRES_EXTERNAL_CONFIGURATION** (operator email provider) |
| Demo provider | AVAILABLE | SUPPORTED (API and browser executor) | delivered (DEMO CONTENT) |

### 10.3 Data caveats (section 3.3)

1. **Resolved.** The migration `20260927130000_automation_backfill` sets `resolved = canConfirm` (and `answerSource`
   GENERATED / UNKNOWN) for drafts without a `questionKey`, and `applicationService.applyNow` re-prepares an application
   whose `preparedAt` is null before anything is submitted.
2. **Unchanged, as intended.** The execution service and `redriveDeferred` only act on REVIEW / AUTO applications;
   a legacy approval is only submitted through an explicit "Approve & apply".
3. **Resolved.** The same backfill migration fills `Application.canonicalJobKey` with the `canonicalJobKey()` formula.
4. **Unchanged.** Pre-migration events keep `actor='user'`.

### 10.4 Invariant changes (section 5)

- 5.1 holds: MANUAL is the default, the web UI, the API routes and the extension never submit, and `07-no-auto-submit`
  enforces it.
- 5.2 is implemented as described; the E2E guard was narrowed, not removed.
- 5.3: `platform-integration-policy.md` now states the headless-browser limits.
- 5.4 **differs from the decision**: automated email applications use `emailService.sendApplicationAutomatically`, which
  calls the same email adapter but not `sendConfirmedEmail` and has no digest-bound token. It runs only inside the
  execution service while the application is `APPLYING`, requires REVIEW / AUTO mode, `allowEmailApplications`,
  `EMAIL_SENDING` and a verified address, checks that the draft is addressed to the job's HR address, that the job post
  asks for applications to exactly that address (`emailApplicationRequested`) and that it was not sent before, refuses
  a non-delivering adapter in production, and is audited as `email.sent` with `automated: true`. With the dev outbox
  the email executor is never selected (manual handoff). The job-description parser only takes an HR address from an
  application context (`applicationContactEmail`), never the first address in the text, and rejects noreply / alert /
  fraud / privacy / security / support addresses. `sendConfirmedEmail` remains the only path for emails the user sends
  from the Email tab, whose preview and send are now compare-and-set.
- 5.5: the mailbox scope was **not** widened; status tracking uses the forwarding address and the demo provider, so no
  new opt-in was needed. Widening it later still requires the opt-in described there.
- 5.6: `SESSION_TOKEN` stays in the enum but is never written (`connect` stores `API_KEY` or `OAUTH_TOKEN` only).

### 10.5 Follow-ups (section 8) and risks (section 7)

| Item | Status |
| --- | --- |
| 8.1 Narrow the E2E scan | Done (and strengthened) |
| 8.2 Prefill for handoffs | Done |
| 8.3 Export / deletion of automation data | Export done; deletion cascades every new table (no provider supports token revocation, so tokens are deleted, not revoked) |
| 8.4 Legacy drafts and canonical keys | Done (backfill migration + re-preparation in `applyNow`) |
| 8.5 Migrate direct notification call sites | **Done**: the three `job-feeds.service.ts` sites and `applicationService.dispatchReminder` use `notificationService` (R42) |
| 8.6 Documentation | Done |
| Risk: duplicate submission after a crash | Mitigated as designed (leases, `SUBMISSION_UNCERTAIN` as a lock only an acknowledged user retry lifts, idempotent demo API only, atomic outcome writes, reconciliation of applications orphaned in APPLYING) |
| Risk: same role via two providers | Mitigated for merged jobs; null `matchKey` and >60-day gaps remain open |
| Risk: ATS forms change / anti-bot | Open by nature: browser adapters are EXPERIMENTAL, off by default, stop on challenges, have a dry-run mode |
| Risk: email applications without per-message preview | Decided as in 10.4 (approval or Auto policy is the confirmation; off by default) |
| Risk: mailbox scope widening | Not taken (10.4, 5.5) |

Additional open items found while verifying: `tailorResume` does not change the tailoring base (R9). Resolved since
(see 10.7): `AutomationSettings.generateCoverLetter` is honoured (R10); the manual email flow is compare-and-set (R27);
the `jobs.new_matches` notification text is mode-neutral (`NEW_MATCHES_BODY`: "Found automatically from your job
sources…").

### 10.6 How this section was verified

Read the current `automation-orchestrator.service.ts`, `automation-settings.service.ts`, `application.service.ts`,
`application-routing.service.ts`, `application-execution.service.ts`, `executors/**`, `email.service.ts`,
`extension.service.ts`, `account.service.ts`, `provider-connections.service.ts`, `candidate-answers.service.ts`,
`resume-selection.service.ts`, `application-email-tracking.service.ts`, `application-status-sync.service.ts`,
`job-feeds.service.ts` (claims, demo feed, inbound handling), `queue/*`, `scheduler.ts`, `worker/main.ts`,
`packages/job-engine/src/{automation,providers}`, the backfill migration and `07-no-auto-submit.spec.ts`. Spot checks
at that time: `grep -rn "prisma.notification.create" apps/web/src` (4 legacy sites), `grep -rn "generateCoverLetter" apps/web/src/server`
(only the settings view), `grep -n "application.update({ where: { id: applicationId }, data: { status" apps/web/src/server/services/email.service.ts`
(preview and send), `grep -rn "applicationEmailTrackingService.ingest" apps/web/src` (forwarding webhook and status sync
only), and the demo catalogue counted with `generateDemoAutomationJobs` (110 jobs, 124 listings). The first three
results changed with the hardening in 10.7; the rows above were updated to the re-checked state.

### 10.7 Hardening after the security and concurrency review

A security / concurrency review of the delivered layer led to behaviour changes; the rows above already describe the
result. In short:

| Area | Current behaviour |
| --- | --- |
| Answers and truth | A generated draft never resolves a required question (`NEEDS_INFORMATION`); an optional generated answer blocks the Auto policy (`WAITING_APPROVAL`); the deterministic fallback never answers yes/no or threshold questions affirmatively; work-authorisation / sponsorship keys carry the question's country, else the job's (`countryForLocations`); unrecognised phrases are never a country; answers to country-less questions are application-scoped even with "remember", and reusable answers are never used for them; relocation "Yes" is never inferred for a named destination; current location is only the user's own answer |
| Approval and retries | `execute()` submits only approved content (`approvedAt`); deferred tasks carry the approval stamp and are skipped when it changed; `APPROVED → APPLYING` requires the approval to be unchanged; edits clear the approval and are refused while APPLYING / once sent; in Review/Auto mode `POST /approve` (also the handoff's "Review & approve") queues the submission and FAILED / MANUAL_ACTION_REQUIRED can be approved; a user retry re-stamps `approvedAt` and needs an approval of the current content; `POST /apply` takes `acknowledgeUncertain: true`, required after `SUBMISSION_UNCERTAIN` |
| Policy re-checks | At routing and at execution: automation on, Auto mode, `AUTO_APPLY` consent, unchanged `rulesVersion`, decision not stale (`automationDecisionIsStale`), and at execution a daily limit above 0; blocked or stale policy approvals go back to `WAITING_APPROVAL` with a review notification; the truth gate also requires no generated answers |
| Settings | `generateCoverLetter` off → no letter generated or sent; `tailorResume` off → approval freezes an approved selected version or a verified-facts resume (never the raw CV parse); `resumeFor` never renders an unapproved version (none → handoff) |
| Email applications | Automatic only with a delivering provider (dev outbox → handoff) and when the post asks for applications to that exact address (`emailApplicationRequested`); the parser takes an HR address only from an application context; manual preview / send are compare-and-set; an email is never sent twice |
| Browser executor | URL re-checked against the adapter allowlist after every navigation, before fills, before and after submit; off-allowlist main-frame navigations are blocked (residual: an HTTP 3xx redirect target is fetched with a GET before the flow stops) |
| Execution robustness | Outcome writes (execution row + application transition + slot release) are atomic; `recoverStale` also reconciles orphaned APPLYING applications; `SUBMISSION_UNCERTAIN` is a lock only an acknowledged user retry lifts; deferred times never fall in quiet hours; a daily limit of 0 means no automatic submission (explicit message); a broken provider connection pauses approved applications (no per-application notice) and reconnecting re-queues them; claim conflicts with another listing are retried later |
| Orchestrator and scheduler | Run lease owned by the run (`runLeaseRunId`), renewed during the run, released only by its owner; stale RUNNING runs closed as FAILED "interrupted"; per-job evaluation errors isolated; one preparation per canonical job across runs; strong-match notifications count only newly strong jobs; re-preparations do not change old run counters; redrive / sweep use suffixed queue keys; a lost-execution sweep re-queues APPROVED Review/Auto applications with no live or finished execution; daily summaries page through all users; the in-process scheduler never overlaps a tick; graceful worker shutdown within 25 s; empty `WORKER_ROLES` = default |
| Status tracking and notifications | Mailboxes still download only job-alert senders; employer emails via the forwarding address and provider status sync (demo); `job_alert_email` STATUS_TRACKING is LIMITED, job boards LIMITED (forwarded employer emails); notification dedupe keys are per episode; the job-feeds notices go through `notificationService` (the per-application reminder is still a direct write) |
| Extension | FAILED / MANUAL_ACTION_REQUIRED Review/Auto applications with an automatic retry scheduled are not handoffs (not listed, no prefill codes; checked at issue and resolve time); approved Review/Auto applications cannot get prefill codes |
| Schema | `20260927140000_automation_hardening` (3.6): `AutomationSettings.runLeaseRunId`, `Application.runtimeQuestions` |

Known limitations after the hardening: the HTTP-redirect GET residual above; parser-derived years of experience /
current title / company are used as profile values when the user left them empty (editable in onboarding and on the
profile; overlapping roles are merged before summing); a bare "Remote" location defaults to "Remote - India" app-wide,
so country-less authorisation questions on such jobs are keyed to India; the demo provider's retry / submitted memory
is per process; the Greenhouse / Lever / Ashby browser adapters are EXPERIMENTAL and not validated against live sites;
automatic applications on LinkedIn, Naukri, Indeed and the other job boards are `EXTERNAL_LIMITATION`.

Verified by reading `packages/job-engine/src/automation/{questions,application-email}.ts`,
`packages/ai/src/fallbacks.ts` (`fallbackScreeningAnswer`), `application-routing.service.ts`,
`candidate-answers.service.ts`, `application-execution.service.ts`, `application.service.ts` (`runPrepare`, `update`,
`approve`, `approveContent`, `applyNow`), `automation-staleness.ts`, `automation-orchestrator.service.ts`,
`email.service.ts`, `executors/{index,email}.ts`, `executors/browser/{flow,playwright-driver}.ts`,
`extension.service.ts`, `notification.service.ts`, `job-feeds.service.ts`, `providers/catalog.ts`, `scheduler.ts`,
`worker/{main,config}.ts`, `queue/index.ts` (`stopWorkers`) and the hardening migration. Spot checks:
`grep -rn "prisma.notification.create" apps/web/src` (outside tests: only the service's own
`createManyAndReturn`), `grep -rn "generateCoverLetter" apps/web/src/server` (`runPrepare`, `buildPayload` and the
settings view), `grep -n "transitionApplication" apps/web/src/server/services/email.service.ts` (preview and send).
