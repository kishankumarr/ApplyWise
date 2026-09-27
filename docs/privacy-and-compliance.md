# Privacy and compliance

> Engineering documentation for the MVP, not legal advice. Review with counsel (including India's Digital Personal Data
> Protection Act, 2023) before launch.

## Personal data we process

Account (email, name, password hash), CV files and extracted text, contact details, work history, education, projects,
skills, preferences (locations, work mode, notice period, optional salary), questionnaire answers, generated drafts,
application history, email drafts, extension tokens (hashed), audit logs. With the automation layer also: automation
settings and rules, automation runs and their per-job items, submission attempts (`ApplicationExecution`), daily
submission counters, reusable application answers (`CandidateAnswer`: e.g. work authorisation, visa, current location,
notice period), metadata of employer status emails (`ApplicationMessage`) and provider connections with encrypted
tokens (`ProviderConnection`). All of it is treated as PII.

## Consent

`UserConsent` stores one row per type with version and timestamps; every change is audited.

| Consent | Default | Effect |
| --- | --- | --- |
| `CV_PROCESSING` | off (asked in onboarding step 1) | Required to upload and parse a CV |
| `AI_PROCESSING` | off | When off, no AI model is used; rule-based parsing and deterministic drafts are used. The consent text names the configured provider and says whether data leaves the server. The consent is recorded with its scope (`2026-09:local` or `2026-09:external`): consent given for a local model does **not** cover an external provider, so after switching `AI_PROVIDER` to Claude or a remote server each user must opt in again (Settings → Privacy shows why). Rows recorded before scoping count as local-only |
| `EMAIL_SENDING` | off | Required before the app sends any **application** email; each manual send also needs the final confirmation, and automated email applications additionally need the user's "allow email applications" setting (off by default). The account-confirmation email (sent only to the user's own address) does not need it |
| `AUTO_APPLY` | off | Standing, revocable authorisation for **Auto** mode to submit applications that pass every rule and safety check, without a per-application approval. Granted only by an explicit action (Automation page, `PUT /api/automation/settings` with `autoApplyConsent`, or `PATCH /api/consents`), audited like every consent. Without it AUTO applications wait for approval; revoking it stops every policy approval that has not started yet: it is re-checked when the submission starts, and the application goes back to the user's review queue. Manual and Review modes never rely on it: Review submits only what the user approved |
| `ANALYTICS` | off | No analytics provider is configured in the MVP |

## Data minimisation

- Forwarded emails: only job content plus subject, sender domain, date and message id are kept — never recipients.
- Browser import: only fields the user reviewed are sent; the backend never visits the page.
- Extension prefill: a short-lived code returns only approved fields; form **values** on third-party pages are never read.
- AI requests contain only the data needed for the task (e.g. verified facts + job text), never passwords or tokens.
- With `AI_PROVIDER=ollama` on the same machine (or your own server), CV and job text are processed locally and are not
  sent to a third party.
- Match scores, rule decisions, resume selection and answer resolution are computed in-process; no profile data leaves
  the server for them.
- Automated submissions send an employer only the application itself: name, email, phone, the user's own links and
  current title/company, years of experience, the current location only when the user answered that question
  themselves (never inferred from preferred locations), an approved resume PDF (never the unreviewed CV parse), the
  approved cover letter (none when the user turned cover letters off) and **resolved** answers (from verified data or
  written by the user; an optional answer drafted by the generator only after the user reviewed and approved it).
  Unknown answers are never sent and nothing is inferred. Credentials are included only for the provider's own API
  call. Current title, company and years of experience may come from the CV parse when the user left those profile
  fields empty; they can be edited in onboarding and on the profile.
- Employer status emails are classified in memory; only metadata is stored (below).

## Security controls

- AES-256-GCM encryption for stored CV files, extracted CV text and parsed sections, mailbox credentials
  (`JobFeed.secretEnc`) and provider tokens (`ProviderConnection.secretEnc`) (`ENCRYPTION_KEY`).
- Opaque storage keys; files only via authenticated download endpoints (`private, no-store`).
- Upload validation: PDF/DOCX only, extension + MIME + magic bytes, size limit, malware scanner interface (stub/ClamAV).
- Auth.js JWT sessions (HTTP-only cookies), bcrypt password hashes, rate-limited sign-in and sign-up.
- Same-origin check on all mutating API calls (CSRF), strict CSP and security headers, `X-Frame-Options: DENY`.
- Every query is scoped to the authenticated user; other users' resources return 404.
- Rate limits on AI generation, uploads, email sending and job imports.
- Structured logs with PII redaction (keys such as `email`, `body`, `text`, `resume`, `answer`, `salary`, tokens; plus
  email/phone/token pattern scrubbing and truncation). No raw CV text, email content or secrets in logs.

## Retention

- Data is kept while the account exists. Uploaded CVs and versions can be removed by deleting the account (per-file
  deletion is a planned enhancement).
- Background task records and audit logs are retained with the account; recommended production policy: prune
  `BackgroundTask` after 30 days and audit logs after 1 year.
- Automation records are kept with the account; there is no automatic pruning yet. `AutomationRun` rows accumulate
  one per run (default every 6 hours per enabled user) with up to one `AutomationRunItem` per evaluated job, prepared
  application and submission attempt (items hold job/application ids, a stage, an outcome and a short message - never CV
  text, answers or credentials). Recommended production policy: delete runs older than 90 days (their items cascade),
  `DailyApplicationCounter` rows older than 30 days, and `ApplicationMessage` metadata with the application it belongs
  to. `ApplicationExecution` rows are the idempotency record that prevents a job from being submitted twice: keep them
  as long as the application.
- Dev outbox files (`.outbox/`) contain email copies — development only.

## Account deletion

`POST /api/account/delete` (confirmation text `DELETE`):

1. Deletes all stored objects under the user's storage prefix.
2. Deletes the `User` row; every personal record cascades (profile, facts, resumes, versions, private jobs, questionnaires,
   answers, applications, drafts, events, notifications, tokens, tasks, audit logs, and the automation tables: settings,
   rules, runs and items, executions, daily counters, reusable answers, status-email metadata and provider connections
   with their encrypted tokens). Mailbox access held for Google is revoked first.
3. Writes one anonymised audit entry (`account.deleted`, HMAC of the user id, no PII).

## Data export

`GET /api/account/export` returns a JSON file with the account, consents, profile and facts, resume metadata **and
decrypted extracted text**, versions, private jobs, questionnaires and answers, applications with drafts and events,
notifications, extension-token metadata and the last 1,000 audit entries. It also includes the automation data:
automation settings and rules, the latest 200 automation runs with their items, submission attempts
(`ApplicationExecution`), reusable answers (`CandidateAnswer`), status-email metadata (`ApplicationMessage`), daily
submission counters, job sources (without credentials or cursors) and provider connections (provider, auth type,
status, masked account label, dates and last error — **never** the encrypted token).

## Email

- Default provider is a local outbox that never delivers.
- The user must first **confirm their account email address** (24-hour link bound to the user and the address, confirmed
  with an explicit button press on the linked page - opening the link alone changes nothing). Until then nothing can be
  sent from the app, and the confirmed address is the only reply-to address used. The confirmation email contains only
  the address and the link (no name or profile data). Accounts created before this check existed must confirm too.
- The send endpoint needs the preview confirmation token (bound to the exact content), explicit confirmation, per-send
  consent and stored `EMAIL_SENDING` consent. Editing after preview invalidates the token.
- "Open in my email client" (mailto:) is always available; the user attaches the resume themselves.
- Automated email applications (REVIEW / AUTO modes only) are off until the user turns on "allow email applications";
  they also need the `EMAIL_SENDING` consent and a confirmed address (plus `AUTO_APPLY` for Auto mode). They are sent
  only to the HR address stated in the job post, and only when the post asks for applications to that exact address
  (an address is only taken from an application context, never a fraud, privacy, support or noreply contact), through
  the same provider adapter, after the user's approval (Review) or the Auto policy, and are recorded as `email.sent`
  with `automated: true`. With the dev outbox they are not sent automatically at all (manual handoff); in production a
  capturing SMTP server is refused. Manual sends are compare-and-set and automated sends run under the execution's
  idempotency claim (an interrupted send is never retried blindly): an application email is never sent twice.

## AI processing

- Provider: Anthropic Claude API, or a self-hosted open-weight model (Ollama / OpenAI-compatible server). Only with
  `AI_PROCESSING` consent. The provider label shown in onboarding and Settings → Privacy comes from the server configuration.
- Output is validated (schemas + claim validator) and always presented as an editable proposal.
- Prompt version and model id are stored with each generated record for traceability.

## Audit logging

`AuditLog` records sensitive actions (consent changes, uploads, parsing, fact verification, imports, generation, edits,
approvals, apply-page opens, submissions, email previews/sends, downloads/exports, token changes, deletion). Metadata is
passed through the same redaction as logs. Automation adds `automation.settings_updated` (field names only),
`automation.run_started` / `run_completed`, `application.auto_approved`, `application.execution_started`,
`application.submitted_by_executor`, `application.execution_failed`, `application.manual_action_required`,
`application.information_provided`, `application.declined`, `application.resume_overridden`, `provider.connected` /
`disconnected` / `auth_failed` and `candidate_answer.saved` / `deleted` (the question key and whether it is sensitive,
never the answer).

## Automatic job sources

- **Mailbox access** (job alerts): connected only by the user, with an explicit consent checkbox; audited
  (`feed.mailbox_connected`). The mailbox is opened read-only and only emails from known job-alert senders are
  downloaded (the automation did not widen this). For job alerts, email bodies, subjects and recipients are never
  stored: only the extracted job fields (title, company, location, link, short summary) and minimal metadata (platform,
  job id, sender domain, received time). Employer status emails are handled separately (below).
- **Credentials**: app passwords and OAuth refresh tokens are encrypted with AES-256-GCM (`JobFeed.secretEnc`), never
  returned by the API, logged, exported or shown again. Removing a source deletes them and revokes Google access;
  account deletion revokes Google access and cascades everything.
- **Forwarding address**: a random, per-user address; the webhook verifies an HMAC over the raw email with a 5-minute
  window. Gmail's forwarding confirmation is shown to the user to confirm in their own account - the server never
  opens that link.
- **Third-party APIs** receive only search keywords, a city and company board names - never CV data.
- **Export**: `GET /api/account/export` includes the user's sources (without credentials or cursors).

## Automation

- **Off by default, per user.** No automation settings exist until the user opens the Automation page; the defaults
  are automation off and Manual mode (prepare only, never submit). Review mode submits only applications the user
  approved; Auto mode submits without a per-application approval only with the `AUTO_APPLY` consent and when every rule
  and safety check passes (see [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md)). Every automated submission is
  recorded with its actor (`policy` / `executor`) on the application timeline and in the audit log, and is capped by the
  user's daily limit.
- **Provider connections** (`ProviderConnection`): only for providers that officially issue API keys or access tokens
  (today the fictional demo provider). The token is AES-256-GCM encrypted (`secretEnc`), decrypted only for that
  provider's own API call, never returned by the API (the UI shows a masked label such as "Key ending 1a2b"), never
  logged and never exported. Expiry or rejection moves the connection to `NEEDS_ATTENTION` and pauses automatic
  applications through it. Disconnecting deletes the row. **Job-platform passwords, cookies and browser sessions are
  never requested or stored**: LinkedIn, Naukri, Indeed and similar boards cannot be connected at all, and the browser
  executor starts every application in a fresh browser context that is discarded afterwards. It only fills and submits
  pages inside its adapter's URL allowlist: navigations elsewhere are blocked, except that an HTTP redirect target is
  fetched with a GET before the flow stops (nothing is read, filled or submitted there).
- **Status emails** (`ApplicationMessage`): employer emails about an application (confirmation, recruiter reply,
  assessment, interview, rejection, offer) that reach the user's private forwarding address are classified in memory.
  Only metadata is stored: a SHA-256 hash of the message id, the sender **domain**, a subject truncated to 200
  characters, the category, the classifier's confidence, how it was associated and whether it changed the status. The
  body and the full sender address are never stored or logged, and ApplyWise never replies. Connected mailboxes are not
  scanned for these emails.
- **Reusable answers** (`CandidateAnswer`): always written by the user - on Settings → Application answers, or when
  answering a "needs information" question (optionally for that application only). Nothing in this table is generated.
  Sensitive answers (salary, notice period, work authorisation, visa, relocation, start date, diversity) are only ever
  taken from values the user entered; the audit log stores the question key, never the answer. Work-authorisation and
  sponsorship answers are stored for one country (the one the question names, else the job's country); when neither is
  known the answer is kept for that application only, even when the user asked to remember it. A general "open to
  relocation" preference is never used as a "Yes" to a named destination, and the current location is only ever the
  user's own answer.
- **Run history** (`AutomationRun`, `AutomationRunItem`): counts and one short message per stage and job (job title,
  company, score and the main rule reason, e.g. "Senior Frontend Engineer at … - score 88: …") - never CV text,
  answers or credentials; provider errors are summarised without credentials. Retention: see above.
- **Notifications** respect the user's quiet hours and are de-duplicated per episode (a retried task never repeats
  one); the daily summary contains counts only. The per-application reminder the user sets is the one notice still
  written directly, without quiet hours.
- **Demo provider**: fictional companies, jobs and replies (`.example` / `.test`); nothing leaves the server. Disabled in
  production unless the operator enables it.
