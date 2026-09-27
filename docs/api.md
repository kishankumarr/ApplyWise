# API reference

All JSON endpoints return the envelope:

```json
{ "success": true, "data": { "...": "..." }, "requestId": "5b0c…" }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "fieldErrors": { "email": ["Enter a valid email"] } }, "requestId": "5b0c…" }
```

Error codes: `VALIDATION_ERROR` (422), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409),
`INVALID_STATE` (409), `CONFIRMATION_REQUIRED` (409), `CONSENT_REQUIRED` (403), `EMAIL_NOT_VERIFIED` (403), `RATE_LIMITED` (429),
`UNSUPPORTED_FILE` (415), `PROVIDER_NOT_CONFIGURED` (501), `INTERNAL_ERROR` (500).

Authentication: Auth.js session cookie (sign in via `/sign-in`). Mutating requests must be same-origin (`Origin` header).
Extension endpoints (`/api/extension/*`, `/api/jobs/import/browser`) accept `Authorization: Bearer awx_…` tokens.
Rate-limited buckets: `auth` 10/min, `ai` 30/min, `upload` 10/min, `email-send` 5/min, `job-import` 30/min, default 120/min
(every automation endpoint uses the default bucket).

Every resource is scoped to the signed-in user: another user's application, run, answer or connection returns
`NOT_FOUND`. No endpoint submits an application in the browser request: submissions only happen in the worker's
execution service (see [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md)), and no endpoint can move an
application to `APPLYING` or `APPLIED`.

## Auth

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | `{ name, email, password, acceptTerms: true }` | then sign in with Auth.js credentials |
| GET/POST | `/api/auth/*` | — | Auth.js handlers |
| GET | `/api/account/verification` | — | `{ email, verified, verifiedAt }` for the signed-in user |
| POST | `/api/account/verification` | — | (re)send the confirmation link (3 per 10 min). Returns `{ sent, alreadyVerified, delivery }` where `delivery` is `external` (real inbox), `catcher` (Mailpit/Mailtrap) or `outbox` (not delivered). Outside production, when mail does not reach a real inbox, it also returns `devVerificationUrl` |
| GET | `/verify-email?token=` (page) | — | Read-only: shows the address and a **Confirm** button. Opening the link changes nothing (mail scanners prefetch links) |
| POST | `/api/account/verification/confirm` | `{ token }` | Public, same-origin, 10/min. Confirms the address; the 24-hour token is bound to the user id and the email address. Idempotent |

## Profile

| Method | Path | Body / query | Response `data` |
| --- | --- | --- | --- |
| POST | `/api/profile/resume/upload` | multipart `file` (PDF/DOCX) | `{ id, originalFileName, status, sizeBytes }` |
| POST | `/api/profile/resume/[resumeId]/parse` | — | `{ resumeId, status: "PARSING", taskId }` |
| PATCH | `/api/profile/resume/[resumeId]` | `{ label?: string \| null, targetRoles?: string[] }` (label ≤ 80 chars, ≤ 10 roles) | `{ id, label, targetRoles }`. Labels a resume variant for automatic resume selection. `resumeId` is a `Resume` id, or the id of a resume version without an uploaded file (then only the label is stored) |
| GET | `/api/profile` | — | `{ profile, onboarding, verification, consents, resumes, resumeFormatWarnings }` |
| PATCH | `/api/profile` | partial `{ yoe, preferredLocations, workModePreference, openToRelocation, targetRoles, noticePeriod, expectedSalaryMin, expectedSalaryMax, fullName, email, phone, currentTitle, currentCompany, portfolioUrl, githubUrl, linkedinUrl, summary, onboardingCompleted }` | profile view |
| POST | `/api/profile/facts/[factId]/verify` | `{ editedText? }` | `{ id, status: "USER_VERIFIED" \| "USER_EDITED" }` |
| POST | `/api/profile/facts/[factId]/reject` | — | `{ id, status: "USER_REJECTED" }` |
| POST | `/api/profile/facts/verify-all` | — | `{ verified: number }` |
| POST | `/api/profile/skills` | `{ name }` | candidate skill |
| GET/PATCH | `/api/consents` | `{ cvProcessing?, aiProcessing?, emailSending?, analytics?, autoApply? }` | consent state `{ cvProcessing, aiProcessing, aiProcessingNeedsRenewal, emailSending, analytics, autoApply }`; `aiProcessingNeedsRenewal` (AI consent was given for a local model but the server now uses an external provider; `aiProcessing` is then `false`). `autoApply` is the standing `AUTO_APPLY` consent that AUTO mode needs to submit; revoking it stops every policy approval that has not started yet (re-checked when the submission starts; the application goes back to `WAITING_APPROVAL`) |

Example:

```http
PATCH /api/profile
Content-Type: application/json

{ "yoe": 5, "preferredLocations": ["Bengaluru", "Remote - India"], "workModePreference": "any", "targetRoles": ["Frontend Engineer"] }
```

## Jobs

| Method | Path | Body / query | Response `data` |
| --- | --- | --- | --- |
| GET | `/api/jobs` | `q, platform (csv), company, location, workMode (csv), minYoe, maxYoe, postedWithinDays, minScore, status (csv, NONE = not started), decision (csv), applyMethod (csv), savedOnly, includeIgnored, newOnly, feedId, sort=score\|posted\|company\|title\|found, order, page, pageSize` | `{ items[], total, page, pageSize, disclaimer, view, sources }` |
| POST | `/api/jobs/manual` | `{ mode: "structured"\|"paste"\|"career_page_url", title?, company?, location?, workMode?, description, requiredSkills?, preferredSkills?, applyUrl?, hrEmail?, sourceUrl? }` | `{ imported: [{ jobId, duplicate, title, company }] }` |
| POST | `/api/jobs/import/csv` | `{ csv }` | same |
| POST | `/api/jobs/import/email` | `{ raw }` (.eml or text) | same |
| POST | `/api/jobs/import/browser` | `{ pageUrl, pageTitle?, title, company?, location?, description, applyUrl?, contactEmail?, userConfirmed: true }` (bearer) | same |
| GET | `/api/jobs/[jobId]` | — | `{ job, sources, contacts, match, disclaimer, state, application, questionnaire }` |
| PATCH | `/api/jobs/[jobId]/state` | `{ saved?, ignored? }` | `{ saved, ignored }` |
| POST | `/api/jobs/[jobId]/analyze` | — | `{ match, disclaimer }` |
| GET/POST | `/api/jobs/[jobId]/questionnaire` | `?regenerate=true` | `{ id, status, provider, modelId, promptVersion, questions[], answers }` (`provider: "fallback"` = rule-based questions) |
| POST | `/api/jobs/[jobId]/questionnaire/answers` | `{ answers: { [questionId]: { value, freeText? } }, complete? }` | questionnaire |
| POST | `/api/jobs/[jobId]/prepare-application` | — | `{ applicationId, status }` (also "prepare anyway" for a job the rules rejected) |

`decision` filters by the automation's rule decision: `IGNORE`, `RECOMMEND`, `REVIEW`, `AUTO_ELIGIBLE`, and/or `NONE`
(not evaluated by the automation). Each item carries `applicationId`, `applicationStatus` and `automationDecision`
(`null` when the automation has not evaluated the job) next to the unchanged score fields.

Match report (`match`):

```json
{
  "estimatedMatchScore": 87, "scoreLabel": "strong", "applicationRecommendation": "apply",
  "scoreFactors": [{ "key": "required_skill_coverage", "label": "Required-skill coverage", "points": 35, "maxPoints": 35, "explanation": "…" }],
  "exactMatches": [{ "requirement": "React", "matchType": "exact", "evidenceLevel": "experience", "sourceFactIds": ["…"], "evidenceText": ["…"] }],
  "relatedMatches": [], "unverifiedMatches": [], "missingMandatoryRequirements": [], "missingPreferredRequirements": [],
  "locationFit": { "fit": "good", "explanation": "Bengaluru is one of your preferred locations." },
  "yoeFit": { "fit": "good", "explanation": "Your 5 years fit the 4-7 year range." },
  "risks": [], "resumeImprovements": [], "resumeFormatWarnings": [], "engineVersion": "match-v1.3"
}
```

## Job sources (automatic intake)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/job-feeds` | — | `{ feeds[], limits, searchProviders[], searchSuggestions[], boardProviders[], suggestedCompanies[], mailbox, alertGuides[], hasProfilePrefs }`; feeds never include credentials |
| POST | `/api/job-feeds/search` | `{ provider, keywords, location?, remoteOnly?, maxDaysOld? }` | saved search; first sync starts immediately; `CONFLICT` for a duplicate |
| POST | `/api/job-feeds/boards/find` | `{ query }` (company name or careers URL) | `{ boards: [{ provider, slug, companyName, jobCount, boardUrl }] }`, checked live (20/min) |
| POST | `/api/job-feeds/boards` | `{ provider, slug, companyName?, onlyRelevant? }` | follow a company |
| POST | `/api/job-feeds/mailbox/imap` | `{ preset, email, appPassword, folder?, consent: true }` | connection is tested first (5 per 10 min) |
| POST | `/api/job-feeds/[feedId]/reconnect` | `{ appPassword }` | replace a rejected app password |
| GET | `/api/job-feeds/mailbox/gmail/start` → `/callback` | — | Google sign-in (read-only scope), returns to `/jobs/sources?connected=gmail` |
| POST | `/api/job-feeds/mailbox/outlook/start` · `/poll` | `{ email, consent: true }` · `{ flowToken }` | Microsoft device-code sign-in |
| POST | `/api/job-feeds/mailbox/forwarding` | — | create/return the private forwarding address |
| PATCH / DELETE | `/api/job-feeds/[feedId]` | `{ paused?, label?, onlyRelevant?, intervalMinutes? }` | delete revokes Google access; found jobs stay |
| POST | `/api/job-feeds/[feedId]/sync` · `/api/job-feeds/sync-all` | — | queue a sync now (10/min); new jobs make the next automation run due immediately |
| POST | `/api/inbound/email` | raw RFC 822 (≤ 5 MB) | server-to-server; headers `x-aw-envelope-to`, `x-aw-timestamp`, `x-aw-signature` (hex HMAC-SHA256 of `"<ts>.<recipient lowercased>." + body` with `INBOUND_EMAIL_SECRET`). A job alert returns `{ accepted: true, kind: "job_alert", fetched, created, merged, skipped }`; an employer email about an application is classified for status tracking and returns `{ accepted: true, kind: "status_email", category, duplicate, associated, statusApplied }` (never which application) |
| PATCH | `/api/jobs/view-prefs` | `{ showDemoJobs?: boolean \| null, markSeen?: true }` | demo-job visibility and "new" badges |

`GET /api/jobs` also accepts `newOnly=true`, `feedId=` and `sort=found`, and returns `view` (`showDemo`, `newCount`, ...)
and `sources` (`total`, `active`, `needsAttention`, `lastSyncAt`); each item has `isNew`, `feed`, `descriptionLevel`
(`SNIPPET` = summary only) and `foundAt`. Error code `PROVIDER_UNAVAILABLE` (503) means an external API is temporarily down.

## Automation

The control centre, runs, review queue and provider cards. Defaults for a new account: automation **off**, mode
`MANUAL` (nothing is submitted). Types are in `packages/types/src/automation.ts`.

| Method | Path | Body / query | Response `data` |
| --- | --- | --- | --- |
| GET | `/api/automation/settings` | — | `AutomationSettingsView` (below) |
| PUT | `/api/automation/settings` | partial `{ enabled, mode, recommendScore, minMatchScore, autoApplyScore, maxApplicationsPerDay, maxJobAgeDays, searchFrequencyMinutes, enabledProviders, quietHoursStart, quietHoursEnd, timezone, tailorResume, generateCoverLetter, allowEmailApplications, notifyStrongMatches, dailySummaryHour, autoApplyConsent, rules }` (strict) | `AutomationSettingsView` |
| POST | `/api/automation/run` | — | `AutomationRunSummary` of the new run (`status: "RUNNING"`); the run itself is a background task. `CONFLICT` while another run of this user holds the lease. Works while automation is off; the mode still decides what is submitted |
| GET | `/api/automation/runs` | `?limit=1..100 (20)&cursor=<runId>` | `{ runs: AutomationRunSummary[], nextCursor }`, newest first |
| GET | `/api/automation/runs/[runId]` | — | `AutomationRunDetail`: the summary + `providers[]` (`{ providerId, label, feedId, fetched, created, merged, skipped, error }`); the step log is paged separately (below) |
| GET | `/api/automation/runs/[runId]/items` | `?page=1..&pageSize=1..100 (50)&stage=&outcome=&q=` (`q`: case-insensitive search in the step messages, ≤ 120 chars) | `AutomationRunItemsPage`: `items[]`, `total`, `page`, `pageSize`, `runTotal`, `stages`, `outcomes`. Each item is `{ id, stage, outcome, message, jobId, applicationId, job: { title, company } \| null, createdAt }`, oldest first; `stages` / `outcomes` count the matching steps per value (each ignoring its own filter) and `runTotal` counts every step of the run. `NOT_FOUND` for another user's run |
| GET | `/api/automation/review` | `?page=1..&pageSize=1..50 (10)` | `{ items: ReviewQueueItem[], total, page, pageSize }`: one page of the applications in `WAITING_APPROVAL`, `READY_FOR_REVIEW` or `NEEDS_INFORMATION` that are not skipped, best match first (the displayed match score, else the score at decision time; ranked on the server, so pages never overlap). Only the requested page is loaded and described. Auto-policy approvals that fail the re-check at submission time (automation off, mode changed, consent revoked, rules changed, decision stale, daily limit 0) come back here as `WAITING_APPROVAL` |
| GET | `/api/automation/review/[applicationId]` | — | one `ReviewQueueItem` for any of the user's applications (the confirmation dialogs use it to show how the application would be sent without loading the queue); `NOT_FOUND` otherwise |
| GET | `/api/automation/providers` | — | `ProviderSourceCard[]`: one card per provider with its capability status on this server, `cardStatus` (`CONNECTED`, `NEEDS_AUTHENTICATION`, `WORKING`, `LIMITED`, `MANUAL_ONLY`, `ERROR`, `NOT_CONFIGURED`), `enabledForAutomation`, `connection` (no secret), `feeds`, `jobsFound`. The demo card is omitted when the demo provider is disabled |
| PUT | `/api/automation/providers/[providerId]/connection` | `{ token (4-4000 chars), accountLabel?: string \| null, expiresAt?: ISO datetime \| null }` | `ProviderConnectionView` `{ status, authType, accountLabel, lastCheckedAt, lastError, expiresAt }` |
| DELETE | `/api/automation/providers/[providerId]/connection` | — | `{ removed: boolean }` |
| POST | `/api/automation/demo` | — | `{ feedId, connected: true, run: AutomationRunSummary \| null }`: adds the fictional demo provider (DEMO CONTENT) as a job source, connects it with a random `demo-` token and starts a run. Never changes the user's mode, thresholds or consents. `PROVIDER_NOT_CONFIGURED` when the demo provider is disabled; `CONFLICT` while a run is in progress |

`PUT /api/automation/settings` rules:

- Scores are integers 0-100 and must satisfy `recommendScore ≤ minMatchScore ≤ autoApplyScore`.
- `maxApplicationsPerDay` 0-500, and at most the operator's `AUTOMATION_MAX_DAILY_LIMIT` (otherwise `VALIDATION_ERROR`).
- `maxJobAgeDays` 1-365; `searchFrequencyMinutes` 15-10080; quiet hours are minutes after local midnight (0-1439, may
  wrap midnight, `null` = off); `timezone` must be an IANA zone; `dailySummaryHour` 0-23 or `null`.
- `enabledProviders`: provider ids from `GET /api/automation/providers` (empty = all); unknown ids are rejected.
- `rules`: partial `{ targetTitles, excludedTitles, preferredCompanies, excludedCompanies, requiredSkills, requiredSkillsMode: "any"|"all", allowMissingMandatorySkills, maxExperienceGapYears (0-20), locationMode: "preferences"|"any", allowedWorkModes, minSalary (null = off), salaryCurrency (3 letters), allowedApplyMethods }`.
- `autoApplyConsent: true|false` grants or revokes the `AUTO_APPLY` consent in the same request (audited like every
  consent change).
- Turning automation on, or changing `searchFrequencyMinutes`, makes the next run due immediately; turning it off clears
  the next run. Changing a rule or threshold bumps `rulesVersion`, so pipeline applications are re-evaluated on the next
  run. Every update writes the audit entry `automation.settings_updated` (field names only).

`AutomationSettingsView`:

```json
{
  "enabled": true, "mode": "REVIEW",
  "recommendScore": 50, "minMatchScore": 70, "autoApplyScore": 90,
  "maxApplicationsPerDay": 10, "maxJobAgeDays": 14, "searchFrequencyMinutes": 360,
  "enabledProviders": [], "quietHoursStart": 1320, "quietHoursEnd": 420, "timezone": "Asia/Kolkata",
  "tailorResume": true, "generateCoverLetter": true, "allowEmailApplications": false,
  "notifyStrongMatches": true, "dailySummaryHour": 20, "rulesVersion": 3,
  "rules": { "targetTitles": [], "excludedTitles": ["intern"], "preferredCompanies": [], "excludedCompanies": [], "requiredSkills": [], "requiredSkillsMode": "any", "allowMissingMandatorySkills": false, "maxExperienceGapYears": 1, "locationMode": "preferences", "allowedWorkModes": [], "minSalary": null, "salaryCurrency": "INR", "allowedApplyMethods": [] },
  "autoApplyConsent": false,
  "status": { "lastRunAt": "…", "nextRunAt": "…", "running": false, "applicationsToday": 2, "dailyLimit": 10, "inQuietHours": false, "lastRun": { "id": "…", "status": "COMPLETED", "jobsFound": 124, "…": "…" } },
  "readiness": { "canAutoApply": false, "blockers": ["Application mode is Review: applications are submitted only after you approve them.", "Grant the auto-apply consent to let the automation submit applications for you."] }
}
```

`readiness.blockers` explains in plain language why AUTO cannot submit right now (automation off, mode, missing
consent, no enabled provider with automatic submission on this server, daily limit 0, missing name/email, no verified
facts, no parsed resume). `AutomationRunSummary` fields: `id, trigger (schedule|manual|demo), status
(RUNNING|COMPLETED|FAILED), mode, startedAt, completedAt, providersChecked, jobsFound, newJobs, duplicates, jobsMatched,
ignored, recommended, reviewRequired, autoEligible, applicationsPrepared, applicationsSubmitted, needsInformation,
manualActions, failures, error`. Counters keep increasing after the run finishes while its preparations and
submissions complete; a later re-preparation of an application (answers given, drafts regenerated) is not counted
again on the run that created it. A run that was interrupted (worker restart, lost task) or superseded by a newer run
ends `FAILED` with an explanatory `error`.

`ReviewQueueItem` (abridged):

```json
{
  "applicationId": "…", "status": "WAITING_APPROVAL", "mode": "REVIEW",
  "job": { "id": "…", "title": "Senior Frontend Engineer", "company": "…", "locations": ["Bengaluru"], "workMode": "hybrid", "platform": "GREENHOUSE", "providerId": "greenhouse", "applyUrl": "…", "isDemo": false, "…": "…" },
  "match": { "score": 88, "label": "strong", "summary": "…", "factors": [{ "key": "…", "label": "…", "points": 30, "maxPoints": 35, "explanation": "…" }], "matchedSkills": ["React"], "missingSkills": [] },
  "decision": { "decision": "REVIEW", "reasons": ["Match score 88 is below the auto-apply threshold 90"] },
  "resume": { "selectedResumeId": "…", "label": "Frontend Resume", "score": 92, "reason": "…", "overridden": false },
  "tailored": { "summary": "…", "unsupportedClaims": 0, "status": "PROPOSED" },
  "coverLetter": "…",
  "answers": [{ "id": "…", "key": "notice_period", "question": "What is your notice period?", "answer": "30 days", "source": "PREFERENCE", "resolved": true, "required": true }],
  "pendingQuestions": [],
  "warnings": [],
  "executor": { "kind": "BROWSER", "id": "browser:greenhouse", "label": "Greenhouse (experimental)", "automatic": true, "detail": "Submitted automatically via Greenhouse (experimental)." },
  "manualActionReason": null, "manualActionDetail": null, "updatedAt": "…"
}
```

Provider connections: a connection is only used for providers whose auth mode (`ProviderInfo.auth`) is `api_key` or
`oauth_token`, i.e. providers that officially issue API keys or tokens (today the demo provider). Job boards and
Workday (`not_supported`) refuse with `VALIDATION_ERROR`, because job-platform passwords and cookies are never stored. The token is AES-256-GCM encrypted, never returned (the view shows a masked `accountLabel` such as
"Key ending 1a2b"), never logged and decrypted only for that provider's own API call. An expired or rejected credential
moves the connection to `NEEDS_ATTENTION`, notifies the user once and pauses automatic submissions for that provider
until it is reconnected: approved applications are held (no per-application "apply manually" notice), and reconnecting
(`PUT …/connection`) re-queues them. Unknown provider ids return `NOT_FOUND`. Audit: `provider.connected`, `provider.disconnected`,
`provider.auth_failed`.

## Reusable answers

Answers the user gives once (work authorisation, visa, current location, notice period, custom questions) and that the
answer resolver reuses for every later application. Always user-authored (`source: "CANDIDATE_ANSWER"`,
`status: "USER_VERIFIED"`); nothing here is generated.

| Method | Path | Body | Response `data` |
| --- | --- | --- | --- |
| GET | `/api/candidate-answers` | — | `CandidateAnswerView[]` `{ id, questionKey, question, answer, source, status, updatedAt }`, newest first (answers saved for one application only are not listed) |
| PUT | `/api/candidate-answers` | `{ questionKey?, question (1-500), answer (1-2000) }` | `CandidateAnswerView`. Creates or replaces the answer for `questionKey`; without one, the key is the question classifier's key (e.g. `notice_period`, `work_authorization:india`, `custom:<hash>`). Work-authorisation and sponsorship answers apply only to the country their question names: one saved without a country (`work_authorization`) is never reused for any job |
| DELETE | `/api/candidate-answers/[answerId]` | — | `{ removed: true }` |

The audit log records the question key and whether it is sensitive, never the answer.

## Dashboard

| Method | Path | Response `data` |
| --- | --- | --- |
| GET | `/api/dashboard/summary` | `DashboardSummary` `{ jobsDiscoveredToday, newMatches, strongMatches, applicationsToday, applicationsThisWeek, waitingApproval, needsInformation, manualActionRequired, interviews, assessments, offers, rejections, automation: { enabled, mode, lastRunAt, nextRunAt, dailyLimit } }`. "Today" is the user's local day; `waitingApproval` counts `WAITING_APPROVAL` + `READY_FOR_REVIEW`, `manualActionRequired` counts `MANUAL_ACTION_REQUIRED` + `FAILED`; `applicationsToday` includes submissions in flight (the daily-limit counter) |

## Applications

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/applications` | `?view=active\|pipeline\|all` (default `active`), `attention=true` (only `READY_FOR_REVIEW`, `WAITING_APPROVAL`, `NEEDS_INFORMATION`, `MANUAL_ACTION_REQUIRED`, `FAILED`), `page=1..`, `pageSize=1..100 (25)` | `{ items[], total, page, pageSize, counts: { active, pipeline, all }, attention }`, newest activity first; `attention` counts the view's rows that need the user. `active` hides the automation pipeline states (`DISCOVERED`, `MATCHING`, `MATCHED`, `REJECTED_BY_RULES`, `AUTO_ELIGIBLE`), `pipeline` shows only those. Each item: `trackingOptions`, `origin` (`USER`/`AUTOMATION`), `mode`, `automationDecision`, `matchScore`, `source`, `appliedAt`, `method` (executor id), `executorKind`, `resumeLabel`, `manualActionReason`, `nextAction` (one-line next step) |
| POST | `/api/applications/batch-prepare` | `{ jobIds: string[] }` (1-10) | per-job results; each still needs review |
| GET | `/api/applications/[id]` | — | full view: drafts (each with `provider` and `modelId`), validation, preview HTML, events (with `actor`), plus `automation`, `resumeSelection` and `messages` (below) |
| PATCH | `/api/applications/[id]` | `{ status?, notes?, tailoredSummary?, tailoredBullets?, coverLetter?, screeningAnswers?, reminderAt? }` | content edits clear the approval (`approvedAt`) and any scheduled submission: an approved Review/Auto application returns to `WAITING_APPROVAL`, other approved states to `READY_FOR_REVIEW`, and a FAILED / MANUAL_ACTION_REQUIRED application needs a new approval before a retry. Content edits are refused (`INVALID_STATE`) while `PREPARING` or `APPLYING`, once sent, and after an uncertain submission. `status` accepts only tracking transitions (never `APPROVED`, `APPLYING`, `APPLIED`, `SUBMITTED`, `EMAIL_SENT` or `AUTO_ELIGIBLE`). A screening answer the user types becomes a resolved, user-authored answer (`source: CANDIDATE_ANSWER`); clearing it marks the question unresolved; unchanged answers keep their source |
| POST | `/api/applications/[id]/approve` | `{ reviewedContent: true }` | creates a `TAILORED` resume version and stamps `approvedAt`. Manual flow (no mode / MANUAL): approval only, nothing is queued. REVIEW / AUTO: `READY_FOR_REVIEW` / `WAITING_APPROVAL` behave like "Approve & apply" (queued for submission); `FAILED` / `MANUAL_ACTION_REQUIRED` are approved and queued again (the handoff's "Review & approve"), except after `SUBMISSION_UNCERTAIN` (`INVALID_STATE`: use Retry) or when never prepared by the automation |
| POST | `/api/applications/[id]/apply` | `{ userConfirmed: true, retry?: boolean, acknowledgeUncertain?: boolean }` | "Approve & apply" (review queue) or "Retry" (below) |
| POST | `/api/applications/[id]/answers` | `{ answers: [{ key, question, answer, remember?: boolean (default true) }] }` (1-30) | answers `NEEDS_INFORMATION` questions; returns the application view |
| GET | `/api/applications/[id]/resume` | — | `{ selection: { resumeId, versionId, label, score, reason, overridden }, ranking: [{ resumeId, versionId, label, score, matchedSkills, missingSkills, roleAligned }] }` ("Why this resume?") |
| PUT | `/api/applications/[id]/resume` | `{ resumeId: string \| null }` | override the selected resume (a `Resume` id or a resume-version id); `null` returns to automatic selection. Returns the application view |
| POST | `/api/applications/[id]/decline` | `{ reason?: string }` (≤ 500) | "Reject" in the review queue: `WITHDRAWN` from any state before sending, and the job is hidden from the inbox. Returns the application view |
| POST | `/api/applications/[id]/skip` | `{ days?: 1-30 }` (default 1) | `{ skippedUntil }`: hides it from the review queue without deciding |
| GET | `/api/applications/[id]/handoff` | — | `ManualHandoffPackage` (below) |
| POST | `/api/applications/[id]/mark-opened` | — | returns `{ applyUrl }` for the client to open |
| POST | `/api/applications/[id]/mark-submitted` | `{ submittedByUser: true, note? }` | the user states they submitted it |
| POST | `/api/applications/[id]/email/preview` | `{ to, cc?, subject, body, resumeVersionId?, attachCoverLetter? }` | returns the exact preview + `confirmationToken` (15 min), `senderEmail`, `senderVerified`, `senderVerification: { delivery, devLinkAvailable }`, `emailSendingConsent` and `canSendFromApp` (consent **and** confirmed address). Only from `APPROVED` / `EMAIL_DRAFT_READY`; `APPROVED → EMAIL_DRAFT_READY` is compare-and-set before the draft changes (`INVALID_STATE` if the automation started meanwhile); `resumeVersionId` must be an approved version; `CONFLICT` once the email was sent |
| POST | `/api/applications/[id]/email/send` | `{ confirmationToken, userConfirmed: true, consentToSend: true }` | requires a **confirmed account email** (`EMAIL_NOT_VERIFIED` otherwise) and `EMAIL_SENDING` consent; queues the send. The send consumes the confirmed preview atomically and moves `EMAIL_DRAFT_READY → EMAIL_SENT` compare-and-set: an email is never sent twice (`CONFLICT` once sent) |
| POST | `/api/applications/[id]/prefill` | — | `{ code, expiresAt }` for the extension (10 min). Allowed for `APPROVED` (manual flow only), `OPENED_APPLY_PAGE`, `MANUAL_ACTION_REQUIRED` and `FAILED`; refused (`INVALID_STATE`) while the automation will still submit it: an approved REVIEW/AUTO application (queued for automatic submission) or a REVIEW/AUTO FAILED / MANUAL_ACTION_REQUIRED application with an automatic retry scheduled. Checked again when the extension resolves the code |

**`POST /api/applications/[id]/apply` safety.** `userConfirmed: true` is required by the schema. It only queues
`application.execute` (the worker performs the submission through the execution service: idempotency claim on the
canonical job, daily-limit slot, compare-and-set `APPROVED → APPLYING`, executor selection). Behaviour by state:

- MANUAL mode (the application's mode, or the account's mode for an application without one) → `INVALID_STATE`: switch
  to Review or Auto, or apply on the official page yourself. An application without a mode takes `REVIEW`.
- Never prepared by the automation (e.g. drafts from before the automation layer) → it is prepared again first
  (`PREPARING`, with verified answer resolution) and routed; nothing is submitted by this call, approve it again when
  it is ready.
- `READY_FOR_REVIEW` / `WAITING_APPROVAL` → approved by the user (a `TAILORED` version is created, `approvedAt`
  stamped) and queued.
- `APPROVED` → queued (compare-and-set: `CONFLICT` if it changed meanwhile). `FAILED` / `MANUAL_ACTION_REQUIRED` → only
  with `retry: true` (e.g. after reconnecting a provider), otherwise `INVALID_STATE`, and only when the current content
  is approved (never approved, or edited since: `INVALID_STATE`, review and approve it first). A retry re-stamps
  `approvedAt`, which invalidates every older deferred task of this application. When the last attempt ended
  `SUBMISSION_UNCERTAIN`, the retry also needs `acknowledgeUncertain: true` (the user checked on the employer's page
  that it was not received); only this lifts the lock, no automatic task touches such an application. Any other state
  → `INVALID_STATE`.
- The approval becomes `approvalSource: "user"`, so it no longer depends on the AUTO policy, and quiet hours do not hold
  it. The daily limit still applies (a limit of 0 means nothing is submitted automatically; the application says so).
  If the job has no automatic executor, the worker hands it back as `MANUAL_ACTION_REQUIRED` with the reason; the
  worker only ever submits approved content and an approved resume version.

**`POST /api/applications/[id]/answers`.** `key` is the pending question's key (`pendingQuestions[].key`). Each answer
is saved as a user-authored `CandidateAnswer`; with `remember: false` it is stored for this application only and not
reused. A work-authorisation / visa-sponsorship key without a country is stored for the job's country when the job's
locations name one (`work_authorization:india`); otherwise it is stored for this application only even with
`remember: true`, because the answer may not hold for a job in another country. When the application is in
`NEEDS_INFORMATION`, the answered questions are removed from `pendingQuestions`
and preparation re-runs (`NEEDS_INFORMATION → PREPARING`) so the answers flow into the drafts; the application is then
routed again. Answers are never written to logs or audit metadata.

`GET /api/applications/[id]` automation fields:

```json
{
  "automation": {
    "origin": "AUTOMATION", "mode": "AUTO", "decision": "AUTO_ELIGIBLE", "decisionScore": 93,
    "decisionChecks": [{ "key": "job_age", "label": "Job age", "outcome": "pass", "effect": "none", "detail": "Posted 3 days ago (max 14)" }],
    "evaluatedAt": "…", "approvalSource": "policy", "executorKind": "API", "executorId": "api:demo",
    "manualActionReason": null, "manualActionLabel": null, "manualActionDetail": null,
    "pendingQuestions": [], "failureReason": null, "appliedAt": "…", "externalApplicationId": "DEMO-…",
    "nextActionAt": null, "preparedAt": "…", "nextAction": "Wait for a response",
    "executor": { "kind": "API", "id": "api:demo", "label": "Demo provider (fictional jobs) API", "automatic": true, "reason": null, "detail": "…" },
    "confirmation": "…"
  },
  "resumeSelection": { "resumeId": "…", "versionId": "…", "label": "Frontend Resume", "score": 92, "reason": "…", "overridden": false },
  "messages": [{ "id": "…", "category": "INTERVIEW", "confidence": 0.9, "subject": "Interview invitation - …", "fromDomain": "example.test", "receivedAt": "…", "statusApplied": true }]
}
```

`screeningAnswers[]` also carry `questionKey`, `required`, `source` (`PROFILE`, `PREFERENCE`, `TRUTH_BANK`,
`PREVIOUS_ANSWER`, `CANDIDATE_ANSWER`, `GENERATED`, `UNKNOWN`) and `resolved`; only resolved answers are ever sent by an
executor. A `GENERATED` answer is never resolved for a required question, and an optional one keeps the AUTO policy
from approving the application (the user reviews it first). `messages` are metadata only (at most 20): no body and no full sender address is stored.

`ManualHandoffPackage`: `{ applicationId, status, job: { id, title, company, locations, applyUrl, hrEmail, providerId,
providerLabel }, reason, reasonLabel, reasonDetail, match: { score, summary, factors[] }, resume: { resumeId, label,
versionId, reason }, tailoredResume: { versionId, label } | null, coverLetter, screeningAnswers: [{ question, answer,
source }] (resolved only), instructions[] }`. Manual-action reasons: `CAPTCHA`, `MFA`, `LOGIN_REQUIRED`,
`UNSUPPORTED_FLOW`, `UNKNOWN_REQUIRED_QUESTION`, `PROVIDER_RESTRICTION`, `AUTOMATION_NOT_SUPPORTED`,
`SUBMISSION_UNCERTAIN` (check whether it was sent before retrying or applying again).

Status flow: manual `SAVED → PREPARING → READY_FOR_REVIEW → APPROVED → (OPENED_APPLY_PAGE → SUBMITTED) | (EMAIL_DRAFT_READY → EMAIL_SENT)`;
automation `DISCOVERED → MATCHED → (REJECTED_BY_RULES | AUTO_ELIGIBLE) → PREPARING → READY_FOR_REVIEW (MANUAL) | WAITING_APPROVAL | NEEDS_INFORMATION | MANUAL_ACTION_REQUIRED | APPROVED (AUTO policy) → APPLYING → APPLIED | FAILED | MANUAL_ACTION_REQUIRED`;
then `ASSESSMENT / INTERVIEW / OFFER / REJECTED` via email tracking or provider status sync, and
`WITHDRAWN / EXPIRED` via tracking or decline.

## Resumes

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/resumes/[resumeId]/export/pdf` · `/docx` · `/txt` · `/html` | returns the file; id may be a `Resume` or `ResumeVersion` id |
| GET | `/api/resumes/[resumeId]/download` | original upload (decrypted) or rendered PDF of a version |
| GET/POST | `/api/resumes/versions` | list · `{ label }` snapshot of the verified profile |
| GET | `/api/resumes/versions/[versionId]` | `{ content, html, text }` |

## Account, integrations, extension

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/account/delete` | `{ confirmText: "DELETE" }` |
| GET | `/api/account/export` | JSON download (includes automation settings, rules, the last 200 runs with their items, executions, reusable answers, status-email metadata, daily counters and provider connections without secrets) |
| GET/POST | `/api/integrations/extension-tokens` | list · create (token shown once) |
| DELETE | `/api/integrations/extension-tokens/[tokenId]` | revoke |
| GET | `/api/extension/me` | bearer; connection check |
| GET | `/api/extension/handoffs` | bearer; `{ items: [{ applicationId, status, job: { title, company, applyUrl }, reason, reasonLabel, reasonDetail, updatedAt }], total }` — at most the 20 newest applications the user applies to by hand (`MANUAL_ACTION_REQUIRED`, `FAILED`, `OPENED_APPLY_PAGE`, and `APPROVED` without an automation mode or in MANUAL mode; REVIEW/AUTO `FAILED` / `MANUAL_ACTION_REQUIRED` applications with an automatic retry scheduled are not handoffs). Read-only; no tokens, CV text, answers or cover letters |
| GET | `/api/extension/prefill?code=` | bearer; `{ applicationId, status, job, fields[], screeningAnswers: [{ question, answer, key, source, reviewed }], coverLetter, coverLetterReviewed, openQuestions: [{ question, required }], resumeDownloadPath, policy }` — only resolved answers backed by verified data or written by the user; unanswered questions are listed, never filled |
| GET/POST | `/api/notifications` | list (notifications held by quiet hours appear when released) · mark all read |
| GET/POST | `/api/admin/demo-data` | development only (`ENABLE_DEMO_ADMIN`) |
| GET | `/api/health` | public DB health check |

The dedicated worker has its own health endpoint (not under `/api`): `GET http://<worker>:$WORKER_HEALTH_PORT/health`
→ `{ ok, roles, queueDriver, lanes, database, scheduler }` (200, or 503 when the database is unreachable).
