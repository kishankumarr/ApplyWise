import { PublicShell } from "@/components/public-shell";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <PublicShell>
      <article className="mx-auto max-w-3xl space-y-4 px-4 py-12 text-sm leading-6">
        <h1 className="text-3xl font-bold">Privacy notice</h1>
        <p className="text-muted-foreground">MVP privacy notice. Have it reviewed by counsel (including for India&apos;s DPDP Act, 2023) before production use.</p>
        <h2 className="pt-4 text-xl font-semibold">What we process</h2>
        <p>Your account details, the CV you upload, the profile facts you confirm, job preferences (locations, work mode, notice period, optional salary), questionnaire answers, generated drafts and application history. We treat resumes, contact details, work history, salary and answers as personal data.</p>
        <h2 className="pt-4 text-xl font-semibold">Consent</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li><strong>CV processing</strong> - required to upload and parse your CV.</li>
          <li><strong>AI processing</strong> - optional. When on, relevant text is processed by the configured AI model - either Anthropic&apos;s Claude API or an open-weight model self-hosted on our own servers (e.g. via Ollama), in which case it is not sent to a third party. When off, only on-server rule-based processing is used.</li>
          <li><strong>Email sending</strong> - optional. Required before we send an application email on your behalf, and every send needs a final confirmation.</li>
          <li><strong>Analytics</strong> - optional and off by default.</li>
        </ul>
        <h2 className="pt-4 text-xl font-semibold">Security</h2>
        <p>Uploaded files and extracted CV text are encrypted at rest (AES-256-GCM). Files are only available through authenticated downloads. Logs are redacted and never contain CV text, email content or secrets.</p>
        <h2 className="pt-4 text-xl font-semibold">Your rights</h2>
        <p>You can export all your data (Settings → Privacy → Export) and delete your account at any time, which permanently removes your profile, files, drafts and applications. A minimal anonymised record that a deletion happened is kept for security auditing.</p>
        <h2 className="pt-4 text-xl font-semibold">Automatic job sources</h2>
        <p>
          If you connect a mailbox, we open it read-only and download only job-alert emails from known job sites (Naukri, LinkedIn, Indeed and similar).
          We keep only the job details found in them (title, company, location, link, short summary) - never the emails themselves. App passwords and
          sign-in tokens are encrypted, never shown again or exported, and deleted when you remove the source (Google access is revoked). Company job
          boards and job-search services only receive the search words, city or company you chose - never your CV.
        </p>
        <h2 className="pt-4 text-xl font-semibold">Third-party platforms</h2>
        <p>We never ask for your job-board passwords, never scrape job sites and never submit applications automatically.</p>
      </article>
    </PublicShell>
  );
}
