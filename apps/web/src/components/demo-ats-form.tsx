"use client";

import { useState } from "react";

/** A screening question on the demo page: plain text (optional) or with required/options metadata. */
export type DemoScreeningQuestion = string | { question: string; required?: boolean; options?: string[] | null };

/** Short, deterministic reference for the demo confirmation (FNV-1a over the submitted values). */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

const field = "mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/**
 * A deliberately ordinary ATS-style form with a variety of label/name/placeholder patterns.
 * DEMO CONTENT: submitting is handled entirely in the browser - nothing is sent anywhere.
 * variant "captcha" adds a clearly fake CAPTCHA box (automation must stop and hand over to the user).
 */
export function DemoAtsForm({ platform, screening, variant = null }: { platform: string; screening: DemoScreeningQuestion[]; variant?: "captcha" | null }) {
  const [reference, setReference] = useState<string | null>(null);
  const [captchaChecked, setCaptchaChecked] = useState(false);
  const [captchaError, setCaptchaError] = useState(false);
  return (
    <form
      className="mt-6 space-y-4"
      data-demo-ats={platform}
      onSubmit={(e) => {
        e.preventDefault();
        if (variant === "captcha" && !captchaChecked) {
          setCaptchaError(true);
          return;
        }
        const parts: string[] = [];
        new FormData(e.currentTarget).forEach((value, key) => parts.push(`${key}=${typeof value === "string" ? value : value.name}`));
        setReference(`DEMO-${shortHash(parts.join("&"))}`);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          First Name *
          <input name="first_name" className={field} autoComplete="given-name" required />
        </label>
        <label className="text-sm">
          Last Name *
          <input name="last_name" className={field} autoComplete="family-name" required />
        </label>
      </div>
      <label className="block text-sm">
        Email *
        <input name="email" type="email" className={field} required />
      </label>
      <label className="block text-sm" htmlFor="phone-field">
        Phone
      </label>
      <input id="phone-field" name="phone" className={field} placeholder="Mobile number" />
      <label className="block text-sm">
        Current location
        <input name="location" className={field} placeholder="City" />
      </label>
      <label className="block text-sm">
        LinkedIn Profile
        <input name="urls[LinkedIn]" className={field} />
      </label>
      <label className="block text-sm">
        GitHub or portfolio URL
        <input name="urls[Portfolio]" className={field} />
      </label>
      <label className="block text-sm">
        Current company
        <input name="org" className={field} />
      </label>
      <label className="block text-sm">
        Total years of experience
        <input name="experience_years" className={field} />
      </label>
      <label className="block text-sm">
        Notice period
        <input name="notice_period" className={field} />
      </label>
      <label className="block text-sm">
        Resume/CV *
        <input name="resume" type="file" className={field} required />
      </label>
      <label className="block text-sm">
        Cover letter
        <textarea name="cover_letter" rows={5} className={field} />
      </label>
      {screening.map((q, i) => {
        const question = typeof q === "string" ? q : q.question;
        const required = typeof q === "string" ? false : !!q.required;
        const options = typeof q === "string" ? null : (q.options ?? null);
        return (
          <label key={question} className="block text-sm">
            {question}
            {required ? " *" : ""}
            {options?.length ? (
              <select name={`question_${i}`} className={field} required={required} defaultValue="">
                <option value="" disabled>
                  Select...
                </option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <textarea name={`question_${i}`} rows={2} className={field} required={required} />
            )}
          </label>
        );
      })}
      {variant === "captcha" ? (
        <div className="g-recaptcha rounded-md border border-dashed border-amber-400 bg-amber-50 p-3 text-amber-950" data-sitekey="demo">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="demo_captcha"
              checked={captchaChecked}
              onChange={(e) => {
                setCaptchaChecked(e.target.checked);
                setCaptchaError(false);
              }}
            />
            I&apos;m not a robot (demo)
          </label>
          <p className="mt-1 text-xs">Fake demo CAPTCHA - not a real challenge. Automation always stops here and hands the application to you.</p>
          {captchaError ? <p className="mt-1 text-xs text-red-700">Tick the demo box to continue.</p> : null}
        </div>
      ) : null}
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        Submit application
      </button>
      {reference ? (
        <p role="status" className="text-sm text-emerald-700">
          Application received (demo) - reference {reference}. Demo only - nothing was sent.
        </p>
      ) : null}
    </form>
  );
}

/** variant "login": a sign-in wall instead of the application form (automation must hand over to the user). */
export function DemoAtsLogin({ platform }: { platform: string }) {
  const [attempted, setAttempted] = useState(false);
  return (
    <form
      className="mt-6 space-y-4"
      data-demo-ats-login={platform}
      onSubmit={(e) => {
        e.preventDefault();
        setAttempted(true);
      }}
    >
      <p className="text-sm text-muted-foreground">Sign in to your candidate account to apply for this job.</p>
      <label className="block text-sm">
        Email
        <input name="username" type="email" autoComplete="username" className={field} required />
      </label>
      <label className="block text-sm">
        Password
        <input name="password" type="password" autoComplete="current-password" className={field} required />
      </label>
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        Sign in
      </button>
      {attempted ? (
        <p role="status" className="text-sm text-amber-800">
          Demo sign-in page - there are no accounts here and nothing was sent.
        </p>
      ) : null}
    </form>
  );
}
