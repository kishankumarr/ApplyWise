# ApplyWise Copilot (browser extension)

Plasmo MV3 extension. It **only acts when you click** and **never submits forms**.

It is the manual-handoff assistant of ApplyWise automation: when the automation cannot (or may not) submit an
application - CAPTCHA, MFA or a login wall, an unsupported flow, a provider that forbids automation, an unknown required
question, a failed or interrupted attempt - or when you apply yourself (MANUAL mode), the application appears in the
popup's **Manual handoffs** list. The extension helps you fill the official form; you always submit it yourself. It is
also the assistant for every provider automation does not support (LinkedIn, Naukri, Workday, company career sites…).

## Build & load

```bash
pnpm --filter @applywise/extension build      # -> build/chrome-mv3-prod
# chrome://extensions → Developer mode → Load unpacked → apps/extension/build/chrome-mv3-prod
```

`pnpm --filter @applywise/extension dev` gives a live-reloading development build. Icon: `node scripts/make-icon.mjs`.

## Connect

1. In ApplyWise open **Settings → Integrations → Create connection token**.
2. Open the extension → Settings → paste the URL (`http://localhost:3000`) and the token → *Save & connect*.

For another domain add it to `manifest.host_permissions` in `package.json` and to `EXTENSION_ORIGINS` on the server.

## Import this job

On a job page you are viewing, click **Import current job**. The extension reads visible text only (title, company,
location, description, apply link, a visible contact email), shows every field for you to edit, and sends it only when you
click **Confirm import**.

## Manual handoffs

When the popup opens (and when you click **Refresh** - it never polls in the background) it calls
`GET /api/extension/handoffs` with your connection token. The list shows at most the 20 newest applications that need
a manual application:

| Status | Meaning |
| --- | --- |
| `MANUAL_ACTION_REQUIRED` | Automation stopped and handed the application to you; the reason is shown (e.g. *The application page shows a CAPTCHA*) |
| `FAILED` | Automation could not finish the application |
| `APPROVED` (mode MANUAL / no automation mode) | You approved it and apply yourself |
| `OPENED_APPLY_PAGE` | You opened the apply page but have not marked it submitted yet |

APPROVED applications in REVIEW/AUTO mode are not listed: an executor submits them. The list contains only the job
title, company, official apply URL and the reason - never tokens, CV text, answers or cover letters.

For each handoff:

1. **Open apply page** opens the official page in a new tab (`chrome.tabs.create`, only `http(s)` URLs, only on your
   click). The popup remembers the handoff and, when you reopen it on that page, highlights it (*this tab*).
2. **Prefill this page** starts the prefill flow below for that application. **Create a prefill code in ApplyWise**
   opens the application in ApplyWise, where you create the 10-minute code; a code for a different application is
   rejected.
3. Review, select, fill - then attach your resume, solve any CAPTCHA / sign in yourself, click Submit on the page, and
   mark the application as submitted in ApplyWise.

If the reason is *Automation was interrupted* (`SUBMISSION_UNCERTAIN`), the popup warns you to check your email or the
employer's portal first so you never apply twice.

## Prefill this page

1. In ApplyWise, click **Create prefill code** on the application's *Apply* tab (valid 10 minutes). Codes can be created
   for applications you apply to yourself: `APPROVED` (MANUAL mode / no automation mode), `OPENED_APPLY_PAGE`,
   `MANUAL_ACTION_REQUIRED` and `FAILED`. An approved REVIEW/AUTO application is refused because it is queued for
   automatic submission (applying by hand as well could send it twice); wait for the result or the handoff.
2. On the official application form, open the extension → **Prefill this page** (on a handoff) or **Prefill with a
   code** → paste the code → **Scan this form**.
3. Review the proposed mapping (field ← value, confidence: adapter/high/medium; medium matches start unselected).
   The payload contains your profile values, the prepared cover letter and screening answers backed by verified data or
   written by you. Answers are matched to fields by their question text. Content you have not reviewed in ApplyWise yet
   (a proposed cover letter, a generated answer) is marked *not reviewed* and starts unselected - read it first
   (the full cover letter and all answers are shown below the list). Questions without a verified answer are listed
   under *Answer these yourself on the page*; nothing is ever invented for them.
4. Select fields and click **Fill selected fields**. Attach your resume and click Submit yourself.

The prefill security is unchanged: the code is created in the signed-in web app, is signed and expires after 10
minutes, is resolved only with your bearer token, and only for your own application while it still waits for you.

## Guarantees

- No content scripts are registered and there is no background worker; code is injected with
  `chrome.scripting.executeScript` only after a click in the popup.
- Permissions: `activeTab`, `scripting`, `storage` (+ the ApplyWise API host). Opening a tab with `chrome.tabs.create`
  needs no extra permission.
- No background polling: no timers or alarms (unit test); API calls happen when the popup opens or on a click.
- Never reads existing form values, never touches file/password/hidden/checkbox/radio inputs or buttons.
- No `submit()`, `requestSubmit()` or `click()` anywhere (ESLint rule + unit test + Playwright test).
- Never solves or bypasses CAPTCHA/MFA/login walls - handoffs exist precisely so that you do those steps yourself.
- No credentials for third-party sites are stored; only your ApplyWise token (revocable) and the id of the last
  selected handoff in `chrome.storage.local`.

## Adapters

`src/lib/adapters.ts`: Greenhouse, Lever, Workday, Ashby field-name adapters (safe, user-triggered mapping only) and a
generic label / placeholder / name / autocomplete matcher (`src/lib/form-match.ts`, which also matches screening
answers to fields by question text). Manual-handoff helpers (apply-URL safety, recognising the handoff open in the
current tab, warnings) live in `src/lib/handoff.ts`.
