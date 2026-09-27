# Automatic job sources

ApplyWise finds jobs for you automatically and puts the ones that match your profile in your inbox. What happens next
depends on your **application mode** (Automation page): in **Manual** mode (the default) you review every job and apply
yourself and nothing is ever submitted for you; in **Review** mode prepared applications wait for your approval; in
**Auto** mode applications that pass every rule are submitted **only where the provider allows it** (see the capability
matrix below). For LinkedIn, Naukri, Indeed and the other job boards that is never the case: they are discovery-only
sources and applying is always a manual handoff.

Open **Jobs → Job sources** (also the last step of onboarding). There are three kinds of source.

| Source | What it covers | Setup for you | Setup for the server operator |
| --- | --- | --- | --- |
| **Your job alerts** (email) | Naukri, LinkedIn, Indeed, Foundit, Instahyre, Cutshort, Wellfound, Glassdoor, Hirist and similar alerts you already receive | Create alerts on those sites, then connect the mailbox they arrive in | None for app passwords; optional Google / Microsoft / forwarding setup (below) |
| **Companies you follow** | Every opening a company posts on Greenhouse, Lever, Ashby, SmartRecruiters, Workable or Recruitee | Type a company name or paste its careers URL, press Follow | None |
| **Saved searches** | Adzuna (on-site and hybrid jobs across Indian cities), The Muse (multinationals' Indian offices), Himalayas and Jobicy (remote jobs open to India) | One click on the suggestions made from your target roles and cities | Optional free Adzuna key for the widest Indian city coverage; The Muse, Himalayas and Jobicy need nothing |

Sources are checked automatically: mailboxes every 30 minutes, companies and searches every 12 hours (you cannot set
them faster than 15 minutes for mailboxes, 3 hours for companies and 6 hours for searches, to respect the providers). You can press
**Sync now** at any time. When new jobs match your profile you get one notification per day ("7 new jobs match your
profile"). With automation on, each automation run (every `searchFrequencyMinutes`, default 6 hours) syncs your due
sources itself and evaluates the new jobs; a Sync now that finds new jobs makes the next run due immediately.

## Why not Naukri, LinkedIn or Indeed directly?

None of them offers an API for job seekers, and their terms forbid automated access to their pages (scraping, bots, or
browser automation), so ApplyWise never visits those sites. Their **job-alert emails** are the supported way to get
their jobs: the sites send them to you, and ApplyWise reads only those emails in your mailbox. For the full description of a
job from an alert, open it and click the ApplyWise browser extension: the existing job is updated (not duplicated) and
its match score recalculated. For the same reason ApplyWise never applies on these sites for you, in any mode: the
automation prepares the application and hands it to you with the official link (see the matrix below).

## What each provider can do (capability matrix)

Every provider reports five capabilities with an honest status for **this server's configuration**
(`packages/job-engine/src/providers/catalog.ts`; shown on **Settings → Job sources** and by
`GET /api/automation/providers`). Statuses: AVAILABLE (works), LIMITED (works partially), NOT_CONFIGURED (an operator
key or flag is missing), SUPPORTED (automatic submission implemented and enabled), EXPERIMENTAL (operator opt-in, not
validated against the live provider), MANUAL (you do this step, with a prepared handoff), EXTERNAL_LIMITATION (the
provider's terms or missing APIs prevent it), REQUIRES_EXTERNAL_CONFIGURATION (needs an agreement or employer
credentials ApplyWise does not have), NOT_SUPPORTED.

| Provider | Discovery | Job details | Application questions | Automatic application | Status tracking |
| --- | --- | --- | --- | --- | --- |
| LinkedIn, Indeed, Naukri, Foundit, Wellfound, Instahyre, Glassdoor, Cutshort, Hirist | LIMITED: your job-alert emails | MANUAL: extension import | EXTERNAL_LIMITATION | EXTERNAL_LIMITATION: manual handoff | LIMITED: forwarded employer emails |
| Greenhouse | AVAILABLE: public job-board API | AVAILABLE | AVAILABLE: official Job Board API | EXPERIMENTAL when the operator enables the browser executor for it, otherwise REQUIRES_EXTERNAL_CONFIGURATION (manual handoff) | LIMITED |
| Lever, Ashby | AVAILABLE | AVAILABLE | NOT_SUPPORTED | as Greenhouse | LIMITED |
| SmartRecruiters, Workable, Recruitee | AVAILABLE | AVAILABLE | NOT_SUPPORTED | REQUIRES_EXTERNAL_CONFIGURATION: manual handoff | LIMITED |
| Workday | NOT_SUPPORTED: use the company's alerts | MANUAL | EXTERNAL_LIMITATION | EXTERNAL_LIMITATION: manual handoff | LIMITED |
| Company career sites | LIMITED: URL import, extension | MANUAL | NOT_SUPPORTED | MANUAL: you apply on the site | LIMITED |
| Himalayas, Jobicy, The Muse | AVAILABLE | AVAILABLE | NOT_SUPPORTED | MANUAL: the provider's apply page | LIMITED |
| Adzuna | AVAILABLE with the operator key, else NOT_CONFIGURED | LIMITED: snippets | NOT_SUPPORTED | MANUAL | LIMITED |
| Job-alert emails | AVAILABLE | LIMITED: alert summary | NOT_SUPPORTED | NOT_SUPPORTED: apply through the platform in the alert | LIMITED: forwarding address only |
| Email applications (the post asks for applications to an HR address) | NOT_SUPPORTED | NOT_SUPPORTED | NOT_SUPPORTED | SUPPORTED with a delivering email provider (`smtp` + `SMTP_HOST`, or `resend` + `RESEND_API_KEY`) and your opt-in; LIMITED (manual handoff) with the dev outbox | LIMITED: forwarded replies |
| Demo provider (fictional) | AVAILABLE | AVAILABLE | AVAILABLE | SUPPORTED (simulated) | AVAILABLE (simulated) |

"LIMITED: forwarded employer emails" means employer emails (confirmation, assessment, interview, rejection, offer)
update your applications when they reach ApplyWise. Today that is the **private forwarding address**: forward employer
replies there (or add a Gmail filter for them). Connected IMAP / Gmail / Outlook mailboxes still download only known
job-alert senders, so employer replies there are not read. Only metadata is kept (a message-id hash, the sender domain
and a truncated subject). The browser executor for Greenhouse / Lever / Ashby runs only when the operator sets
`BROWSER_EXECUTOR_ENABLED=true` and lists the provider in `BROWSER_EXECUTOR_PROVIDERS`; it is experimental (not
validated against the live sites), only fills and submits pages inside the adapter's URL allowlist, stops at CAPTCHA,
MFA, sign-in walls and unknown required questions and hands the application to you.

An email application goes out only when the job post itself asks for applications to that exact address (ApplyWise
takes the HR address from an application context such as "How to apply" or "send your CV to …", never simply the first
address in the text, and ignores noreply, alert, fraud, privacy and support addresses). With the development outbox
nothing is sent automatically: the application is handed to you.

In the automation rules (**Automation → Enabled job sources**), a job is attributed to the provider it came from: a
company board or search to that provider, a job-alert email to the **platform named in the alert** (a LinkedIn alert
job counts as `linkedin`, not as "job-alert emails").

## Provider connections

Some providers officially issue API keys or access tokens for applying. Those can be connected on **Settings → Job
sources** (`PUT /api/automation/providers/[providerId]/connection`); today that is only the demo provider. The token is
encrypted (AES-256-GCM), never shown again, never logged and never exported, and it is decrypted only for that
provider's own API call. When it expires or the provider rejects it, the connection shows **Needs authentication**, you
get one notification and automatic applications through that provider pause until you reconnect (approved applications
wait without an "apply manually" notice each, and go out once you reconnect). Job boards such as
LinkedIn, Naukri and Indeed cannot be connected at all: ApplyWise never asks for or stores job-platform passwords,
cookies or browser sessions.

## Demo provider (DEMO CONTENT)

A fictional provider for trying the automation without real accounts: 110 jobs from simulated LinkedIn, Naukri, Indeed,
Wellfound, Greenhouse, Lever and career-site sources plus 14 cross-provider duplicate listings (merged into one job
each), with scripted outcomes: successful submissions, a retried transient failure, a closed posting, CAPTCHA / sign-in /
MFA handoffs, unknown required questions, platforms that do not allow automation, and simulated employer replies
(assessment, interview, rejection, offer). Its companies, URLs (`.example`) and emails are fictional and nothing leaves
the server. Add it with **Automation → Try the demo**, or run `pnpm demo:automation` for the seeded demo user
([running-guide.md](running-guide.md#4-automation-worker-and-demo)). It is available outside production and off in
production unless the operator sets `DEMO_PROVIDER_ENABLED=true`.

## How jobs are combined

- The same job found through several sources (an alert, a search and the extension) becomes **one** job with all its
  sources listed.
- Jobs that arrive as a short summary (alerts, Adzuna snippets) show a **Summary only** badge until the full
  description is added.
- Company boards and searches are filtered to jobs that match your **target roles and locations** (you can turn the
  filter off per company). Alerts are never filtered: you chose them.
- Demo jobs are hidden automatically once your own jobs arrive (toggle in the inbox).

## Connecting your mailbox

ApplyWise opens the mailbox **read-only** and downloads only emails from known job-alert senders. Email content is
parsed in memory and discarded; only the extracted job fields (title, company, location, link, short summary) are
stored. Credentials are encrypted (AES-256-GCM) and never shown again, logged or exported. Removing the source
deletes them (and revokes Google access).

**Gmail, Yahoo, iCloud or Zoho: app password (recommended for a local setup, 2 minutes)**

1. Create an app password: Gmail https://myaccount.google.com/apppasswords (needs 2-Step Verification),
   Yahoo https://login.yahoo.com/account/security, iCloud https://account.apple.com (App-Specific Passwords),
   Zoho: Accounts → Security → App Passwords, and enable IMAP access in Zoho Mail settings.
2. In Job sources → *Connect email with an app password*: enter your address, paste the app password, tick the
   consent box, **Connect**. The connection is tested before anything is saved.

**Gmail with Google sign-in** (read-only `gmail.readonly` scope; the operator must configure it, see below).

**Outlook.com / Hotmail / Microsoft 365**: Microsoft no longer accepts app passwords. Use *Connect Outlook*: you get a
one-time code to enter at microsoft.com/devicelogin (the operator must configure it, see below).

**Forwarding address** (hosted deployments): ApplyWise gives you a private address; you add it as a Gmail forwarding
address and create a filter that forwards only job alerts. Gmail's confirmation email appears on the Job sources page
with a *Confirm in Gmail* button: you confirm it in your own Google account. Never choose "forward a copy of all
incoming mail".

## Operator setup (`.env`, restart after changes)

| Feature | Variables | Notes |
| --- | --- | --- |
| Indian city searches (Adzuna) | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, optional `ADZUNA_DAILY_LIMIT` / `ADZUNA_WEEKLY_LIMIT` / `ADZUNA_MONTHLY_LIMIT` (defaults 200 / 900 / 2300) | Free key: https://developer.adzuna.com/signup (default terms 250 calls/day, 1000/week, 2500/month). Only real API calls count; identical searches from several users share one response per hour |
| The Muse (optional) | `THE_MUSE_API_KEY` | Works without a key at a lower rate limit |
| Gmail sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | See below |
| Outlook sign-in | `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT` (`common` default, `consumers` for personal accounts only) | See below |
| Forwarding address | `INBOUND_EMAIL_DOMAIN`, `INBOUND_EMAIL_SECRET` (24+ random characters) | See `infra/cloudflare-email-worker/README.md` |
| Scheduler | `FEEDS_SCHEDULER=on` (default), `FEEDS_TICK_SECONDS` (default 300) | Runs inside the web process in development; in production the dedicated worker (`pnpm worker`, `WORKER_ROLES` with `scheduler`) runs it and the web process sets `FEEDS_SCHEDULER=off`. Claims are atomic, so several instances are safe |
| Custom IMAP hosts | `ALLOW_CUSTOM_IMAP_HOST=true` | Off by default so the server only connects to known mail providers |
| Demo provider | `DEMO_PROVIDER_ENABLED` | Unset: on outside production, off in production |
| Browser executor for Greenhouse / Lever / Ashby (experimental) | `BROWSER_EXECUTOR_ENABLED=true`, `BROWSER_EXECUTOR_PROVIDERS=demo,greenhouse,…` | Off by default; Chromium in the worker. See [running-guide.md](running-guide.md#browser-executor-optional-off-by-default) |
| Automatic email applications | `EMAIL_PROVIDER=smtp` (+ `SMTP_HOST`, `SMTP_DELIVERS_EXTERNALLY=true` for a real relay) or `resend` (+ `RESEND_API_KEY`) | Each user must also allow email applications, grant the email-sending consent and confirm their address. The dev outbox never sends them automatically, and in production an SMTP server without `SMTP_DELIVERS_EXTERNALLY=true` is refused |

**Google (Gmail sign-in), about 10 minutes, free**

1. https://console.cloud.google.com: create a project, then enable the **Gmail API**
   (https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. Google Auth Platform → **Branding**: app name, support email, Audience *External*.
3. **Data Access** → add the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. **Clients** → Create client → *Web application* → authorized redirect URI
   `http://localhost:3000/api/job-feeds/mailbox/gmail/callback` (use your https `APP_URL` in production).
   Copy the client secret immediately: it is shown only once.
5. **Audience → Publish app.** In *Testing* mode Google expires the connection after 7 days. An unpublished personal
   app shows "Google hasn't verified this app" (Advanced → continue); that is expected for self-hosting.
   A hosted service for other people needs Google's restricted-scope verification and a security assessment; use the
   forwarding address there instead.

**Microsoft (Outlook sign-in)**

1. https://entra.microsoft.com → App registrations → New registration → *Accounts in any organizational directory and
   personal Microsoft accounts*.
2. Authentication → **Allow public client flows: Yes** (device-code sign-in, no redirect URI or secret needed).
3. API permissions → Add → *APIs my organization uses* → **Office 365 Exchange Online** → delegated
   `IMAP.AccessAsUser.All`, plus `offline_access`.
4. Put the *Application (client) ID* in `MICROSOFT_CLIENT_ID`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Mailbox shows **Needs attention** | The app password was revoked or changed, or Google/Microsoft access expired: remove the source and connect again |
| "Adzuna is not configured" | Add the two Adzuna variables and restart; remote searches work without keys |
| A company cannot be found | It may use Workday, Keka, Darwinbox or an in-house portal without a public API: create a job alert on its careers page or on Naukri/LinkedIn instead |
| No jobs from a company | The filter keeps only jobs matching your target roles and locations: set them in Profile, or turn *Only matching jobs* off for that company |
| Jobs arrive only as summaries | Open the job, then click the browser extension to add the full description |
| A LinkedIn / Naukri / Indeed job is "Manual action required" | Expected: those platforms allow no automated applications. Open the handoff, apply on the official page (optionally with the extension's prefill) and mark it submitted |
| Summary-only jobs are never auto-applied | Expected: a description snippet caps the rule decision at Review; add the full description with the extension |
| Provider card shows **Needs authentication** | Reconnect the provider's key/token on Settings → Job sources: approved applications that were waiting are submitted again automatically; retry the ones that were handed back to you ("Manual action required") |
