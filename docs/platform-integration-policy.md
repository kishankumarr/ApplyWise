# Platform integration policy

ApplyWise only brings jobs in through channels the user or the platform has authorised. Every connector declares one
integration class (`packages/types/src/enums.ts`, `IntegrationClass`), shown in the UI and stored on `JobSource`.

| Class | Allowed channel | Implementation |
| --- | --- | --- |
| `official_api` | A platform's documented public or partner API | Company job boards the user follows: Greenhouse, Lever, Ashby, SmartRecruiters, Workable and Recruitee public job-board APIs (`packages/job-engine/src/feeds/boards`); `officialPartnerApiConnector` (disabled by default) |
| `job_search_api` | A job-search API whose terms allow this use, queried with the user's saved search | Adzuna (operator key), Himalayas, Jobicy, The Muse (`packages/job-engine/src/feeds/search`); attribution shown with every job |
| `partner_feed` | A feed a partner has granted us an API key for | `apiKeyFeedConnector` (disabled by default) |
| `user_forwarded_email` | Job-alert emails the user received and chose to paste/upload or forward to their private address | `forwardedEmailConnector`, inbound webhook |
| `user_mailbox_alert` | Job-alert emails in the user's own mailbox, read read-only after the user connects it (IMAP with an app password, Gmail API `gmail.readonly`, or Microsoft OAuth) | `packages/mail-sources` + `feeds/alerts` |
| `user_initiated_browser_import` | The page the user is viewing, after they click "Import", with a preview | `browserImportConnector` + extension |
| `user_manual_entry` | Manual entry, pasted descriptions, CSV files, seeded demo data | `manualEntryConnector`, `pastedDescriptionConnector`, `csvImportConnector`, `seededDemoConnector` |
| `career_page_url` | An official career-page URL plus the description the user pasted — **the page is not fetched** | `careerPageUrlConnector` |
| `unsupported` | Everything else | not implemented |

## Prohibited — never implement

- **Scraping** of job boards, career sites, or search results (including headless browsers, crawling, or fetching pages
  the user did not explicitly import). The worker-side browser executor is not an exception to this rule: it opens only
  the apply page of an application that was approved for submission, never for discovery or for reading other pages,
  stays within its adapter's URL allowlist (main-frame navigations elsewhere are blocked, and the page URL is re-checked
  after every navigation, before filling and around submit; the one residual is that an HTTP redirect target is fetched
  with a GET before the flow stops, without reading, filling or submitting anything there), is off by default
  (`BROWSER_EXECUTOR_ENABLED`), runs only for the providers the operator lists (`BROWSER_EXECUTOR_PROVIDERS`, default
  `demo`), uses no stealth or fingerprint evasion, and is never used on LinkedIn, Indeed, Naukri or any other site
  whose terms forbid automation.
- **Credential harvesting**: asking for, storing or using a user's password, cookies or browser session for any job platform
  (LinkedIn, Naukri, Indeed, ...) or any other site the user has an account with. The only exception is the user's
  **own mailbox**, connected explicitly for job alerts: preferably via OAuth (Gmail, Microsoft) or a forwarding address;
  otherwise with a revocable **app-specific password** (never the account password), encrypted at rest, used only to
  read job-alert emails read-only, never logged or exported, and deleted when the source is removed.
- **CAPTCHA bypass** or any attempt to evade bot detection or rate limits.
- **Automated LinkedIn activity** of any kind (search, connection requests, messages, Easy Apply, profile views).
- **Unattended submission outside the automation guardrails**: auto-clicking final submit from the web UI or the
  extension, programmatic `form.submit()` / `requestSubmit()` anywhere except the worker-side browser executor, or any
  automatic submission that does not satisfy every condition in "Automated applications" below.
- **Platform-protection bypass**: CAPTCHA solving or bypass, MFA bypass, anti-bot evasion, stealth fingerprinting,
  access-control bypass or rate-limit circumvention. When any of these is encountered, the application stops with
  `MANUAL_ACTION_REQUIRED` and a reason (`CAPTCHA`, `MFA`, `LOGIN_REQUIRED`, ...), and is handed to the user.
- **Background activity in the extension**: no content scripts, no background polling or page reading.
- **Fabrication**: generating experience, metrics, employers, skills, degrees, certifications or screening answers that
  are not supported by the user's verified facts.

## Automated applications (since the automation layer)

ApplyWise can submit applications on the user's behalf, but only through the worker-side execution service
(`apps/web/src/server/services/application-execution.service.ts`) and only when ALL of these hold:

1. The user chose **Review** mode and approved this application, or chose **Auto** mode and granted the standing
   `AUTO_APPLY` consent (a separate, revocable consent) - and the rule engine rated the job `AUTO_ELIGIBLE` under the
   current Auto rules, with a decision that is not stale (profile and match score unchanged since the evaluation).
   Automation, Auto mode, the consent, the rules and the decision's freshness are checked when the application is
   routed and again when the submission starts; a policy approval that fails either check goes back to the user's
   review queue. Only the approved content is ever sent: editing it clears the approval. **Manual** mode never submits.
2. The provider's `AUTO_APPLY` capability is `SUPPORTED` (or `EXPERIMENTAL` and explicitly enabled by the operator), and
   an executor exists for the flow: the provider's official API, the employer's HR email address (only when an email
   provider is configured - SMTP or Resend, not the dev outbox; in production it must deliver externally - the user
   allowed email applications, and the job post itself asks for applications to that exact address), or the headless
   browser executor in the worker (`BROWSER_EXECUTOR_ENABLED`, provider allowlist `BROWSER_EXECUTOR_PROVIDERS`), which
   fills and submits only on pages inside its adapter's URL allowlist. No executor runs in the user's browser.
3. Every required question has an answer from verified data or the user's own answers (a generated draft never answers
   a required question); in Auto mode no answer was drafted by the answer generator; truth validation passed.
4. The daily limit is above 0 and has a free slot (atomic counter), and for Auto-policy approvals it is not the user's
   quiet hours.
5. The same canonical job has never been submitted before (idempotency key `userId:canonicalJobKey`), and no earlier
   attempt may have reached the employer unless the user checked and explicitly asked for a retry.

Everything else ends in a **manual handoff** with the prepared resume, cover letter, answers and the reason. The browser
extension remains the user-triggered assistant for those cases and still never submits; it offers no handoff and no
prefill while an automatic submission or retry of the application is still queued.

Email applications: the `api:email` executor sends the prepared application email only to the HR address named in the
job post, only when the post asks for applications to that exact address (an address is taken from a job post only
from an application context such as "send your CV to …", never "the first address in the text", and noreply / alert /
fraud / privacy / support addresses are rejected), only with a configured email provider (SMTP or Resend; with the dev
outbox it is a manual handoff, and in production a capturing SMTP server is refused), and only when the user turned on
"allow email applications" (off by default), granted `EMAIL_SENDING` (and `AUTO_APPLY` for Auto mode) and confirmed
their address. It uses the same email adapter as the manual send; the manual send's preview token is replaced by the user's approval (Review) or the Auto policy, and the
send is recorded with actor `executor` and `automated: true`. An application email is never sent twice.

Status tracking reads only what reaches ApplyWise: employer emails forwarded to the user's private forwarding address
(metadata stored, never replied to) and the status API of providers that offer one (today the demo provider).
Connected mailboxes remain limited to known job-alert senders, so every job board's status tracking is `LIMITED`
(forwarded employer emails only).

Provider accounts: providers that officially offer API keys or OAuth tokens can be connected explicitly
(`ProviderConnection`, AES-256-GCM encrypted, never returned to the client, never logged; expiry or rejection moves the
connection to `NEEDS_ATTENTION`, notifies the user once and holds approved applications for that provider until the
user reconnects, which re-queues them). Job-platform passwords, cookies and browser sessions are never requested or
stored.

| Provider | Automatic submission |
| --- | --- |
| LinkedIn, Indeed, Naukri, Foundit, Wellfound, Instahyre, Glassdoor, Cutshort, Hirist, Workday | `EXTERNAL_LIMITATION` - no candidate-side application API; terms prohibit automation or require login. Manual handoff. |
| Greenhouse, Lever, Ashby | `EXPERIMENTAL` via the worker browser executor only when the operator enables it (not validated against the live sites); otherwise `REQUIRES_EXTERNAL_CONFIGURATION` (their submission APIs need the employer's key). CAPTCHA -> manual. |
| SmartRecruiters, Workable, Recruitee, company career sites, search APIs | Manual handoff. |
| Employer HR email (job asks for email applications to that address) | `SUPPORTED` when a delivering email provider is configured and the user allowed email applications; with the dev outbox `LIMITED` (manual handoff). |
| Demo provider (DEMO CONTENT) | `SUPPORTED` (simulated). |

## Required for any new connector

1. Written permission (API terms, partner agreement) or a user-initiated action; record the integration class.
2. Nothing runs until someone opts in: partner integrations stay behind an explicit `ENABLE_*` flag with credentials in
   environment variables; automatic job sources (company boards, search APIs, mailboxes) run only for sources a user
   added themselves, and keyed providers only when the operator configured a key.
3. Preserve raw source metadata and attribution (`JobImportEvent.rawPayload`, `JobSource.metadata`) — but keep only the
   minimum needed (e.g. no recipient addresses from forwarded email).
4. Respect the source's rate limits and terms; never deep-link around login walls.
5. Unit tests with fixtures; no network calls in CI.

## Platform-specific notes

| Platform | Status | Compliant alternatives |
| --- | --- | --- |
| LinkedIn | Discovery via job-alert emails only; no public job/apply API; automation prohibited | Forward job-alert emails; extension import of a page you opened; paste the JD; manual handoff for applying |
| Naukri | Requires an approved partnership | Forward alerts; extension import; paste; manual handoff |
| Indeed | Requires a publisher/partner agreement | Forward alerts; extension import; CSV; manual handoff |
| Instahyre | No partner API configured | Forward alerts; paste; manual handoff |
| Greenhouse / Lever / Ashby | Official public job-board APIs per company (users follow a company in Job sources); Greenhouse's Job Board API also provides the application questions. Submission APIs need the employer's key, so applying is a manual handoff unless the operator opts in to the experimental browser executor | Career-page URL import; extension prefill adapters |
| SmartRecruiters / Workable / Recruitee | Official public job-board APIs per company; submission needs employer credentials | Manual handoff; extension prefill (generic matcher) |
| Workday | No public feed; per-employer candidate accounts | Company job alerts; career-page URL import; extension prefill adapter; manual handoff |

The full, environment-resolved capability matrix is in [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md#providers-and-capabilities)
and [job-sources.md](job-sources.md#what-each-provider-can-do-capability-matrix).

## Automatic job sources

- Job-alert emails are the supported way to get LinkedIn, Naukri and Indeed jobs automatically. Only emails from known
  job-alert senders are downloaded (server-side search), parsed in memory and discarded; links in them are never
  fetched (tracking redirects are unwrapped offline).
- Company boards and job-search APIs are called server-side only, with timeouts, a descriptive User-Agent, per-provider
  quotas (Adzuna's daily budget, shared caching of identical searches) and exponential backoff.
- Provider attribution ("Jobs by Adzuna", "via Himalayas", ...) is stored on every job's source and shown with it; apply
  links always go to the provider's page (e.g. Adzuna's `redirect_url`).
- Jobs stay private to the user who found them: nothing is published, indexed or resold.
- Portals without a public API (Workday, Keka, Darwinbox, Freshteam, in-house sites) are detected and the user is pointed
  to job alerts instead. Nothing is scraped.
