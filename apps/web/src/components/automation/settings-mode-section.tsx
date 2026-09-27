"use client";

import Link from "next/link";
import type { Ref } from "react";
import { CheckCircle2, Circle, Info } from "lucide-react";
import { APPLICATION_MODE_DESCRIPTIONS, APPLICATION_MODE_LABELS, APPLICATION_MODES, type ApplicationMode, type AutomationSettingsView, type ProviderSourceCard } from "@applywise/types";
import { Alert, AlertDescription, Badge, Card, CardContent, Checkbox, cn } from "@applywise/ui";
import { canAutoSubmit, SectionHeading } from "./control-shared";
import type { FormApi } from "./settings-form";

const MODE_NOTE: Record<ApplicationMode, string> = {
  MANUAL: "Never submits anything",
  REVIEW: "You approve each application",
  AUTO: "Needs your explicit consent",
};

/** Where to fix a readiness blocker (matched on the server's plain-language text). */
function blockerLink(blocker: string): { href: string; label: string } | null {
  const b = blocker.toLowerCase();
  if (b.includes("resume")) return { href: "/resume", label: "Go to Resume" };
  if (b.includes("profile")) return { href: "/profile", label: "Go to Profile" };
  if (b.includes("job source")) return { href: "/settings/job-sources", label: "Job sources" };
  return null;
}

export function SettingsModeSection({
  api,
  saved,
  providers,
  consentError,
  consentRef,
  dirty,
  dailyLimit,
}: {
  api: FormApi;
  saved: AutomationSettingsView;
  providers: ProviderSourceCard[] | undefined;
  consentError: boolean;
  consentRef: Ref<HTMLButtonElement>;
  dirty: boolean;
  /** The daily limit the consent refers to (the edited value, capped by the server maximum). */
  dailyLimit: number;
}) {
  const { form, set, disabled } = api;
  const showConsent = form.mode === "AUTO" || saved.autoApplyConsent;
  const enabledIds = form.providerScope === "all" ? null : new Set(form.enabledProviders);
  const autoCapable = (providers ?? []).filter((p) => (!enabledIds || enabledIds.has(p.id)) && canAutoSubmit(p.capabilities.AUTO_APPLY.status));

  return (
    <Card role="region" aria-labelledby="mode-title">
      <SectionHeading id="mode-title" step={1} title="Application mode" description="What happens after a job matches your rules. You can change this at any time." />
      <CardContent className="space-y-4">
        <fieldset disabled={disabled}>
          <legend className="sr-only">Application mode</legend>
          <div className="grid gap-3 md:grid-cols-3">
            {APPLICATION_MODES.map((m) => {
              const selected = form.mode === m;
              return (
                <label
                  key={m}
                  className={cn(
                    "relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                    selected ? "border-primary bg-primary/5" : "hover:bg-accent/40",
                  )}
                >
                  <input
                    type="radio"
                    name="automation-mode"
                    value={m}
                    checked={selected}
                    onChange={() => set("mode", m)}
                    className="sr-only"
                    aria-labelledby={`mode-${m}-title`}
                    aria-describedby={`mode-${m}-desc`}
                  />
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-primary" : "border-muted-foreground/50")}
                    >
                      {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                    </span>
                    <span id={`mode-${m}-title`} className="font-semibold">
                      {APPLICATION_MODE_LABELS[m]}
                    </span>
                    {saved.mode === m ? (
                      <Badge variant="outline" className="ml-auto">
                        Current
                      </Badge>
                    ) : null}
                  </span>
                  <span id={`mode-${m}-desc`} className="text-sm text-muted-foreground">
                    {APPLICATION_MODE_DESCRIPTIONS[m]}
                  </span>
                  <span className="text-xs font-medium">{MODE_NOTE[m]}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {form.mode === "MANUAL" ? (
          <Alert variant="info" role="note">
            <Info className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Manual mode never submits anything. ApplyWise finds, matches and prepares applications; you review them and apply yourself.
            </AlertDescription>
          </Alert>
        ) : form.mode === "REVIEW" ? (
          <Alert variant="info" role="note">
            <Info className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Nothing is sent until you approve it in the review queue. Approved applications are submitted only where the job source supports it; otherwise you get
              everything prepared to apply yourself.
            </AlertDescription>
          </Alert>
        ) : null}

        {showConsent ? (
          <div
            className={cn(
              "rounded-md border p-4",
              consentError ? "border-destructive bg-destructive/5" : form.autoApplyConsent ? "bg-muted/20" : "border-amber-300 bg-amber-50/70 dark:bg-amber-950/20",
            )}
          >
            <div className="flex items-start gap-3">
              <Checkbox
                ref={consentRef}
                id="auto-apply-consent"
                checked={form.autoApplyConsent}
                disabled={disabled}
                onCheckedChange={(c) => set("autoApplyConsent", c === true)}
                aria-labelledby="auto-apply-consent-label"
                aria-describedby={form.mode === "AUTO" && !form.autoApplyConsent ? "auto-apply-consent-note auto-apply-consent-error" : "auto-apply-consent-note"}
                aria-invalid={consentError || undefined}
                className="mt-0.5"
              />
              <label htmlFor="auto-apply-consent" id="auto-apply-consent-label" className="cursor-pointer text-sm font-medium leading-snug">
                I allow ApplyWise to submit job applications on my behalf, using only my verified information, within my daily limit (currently{" "}
                {dailyLimit} per day). I can turn this off at any time.
              </label>
            </div>
            <p id="auto-apply-consent-note" className="mt-2 pl-7 text-xs text-muted-foreground">
              {saved.autoApplyConsent ? "You have given this consent. " : ""}
              Your choice is recorded when you save. Automatic submission only happens in Auto mode and only where a job source supports it; a CAPTCHA, sign-in,
              multi-factor prompt or unanswered question always comes back to you. Untick this, or choose Review or Manual mode, to stop automatic submissions.
            </p>
            {form.mode === "AUTO" && !form.autoApplyConsent ? (
              <p id="auto-apply-consent-error" role={consentError ? "alert" : undefined} className={cn("mt-2 pl-7 text-sm", consentError ? "font-medium text-destructive" : "text-amber-900 dark:text-amber-100")}>
                Auto mode needs this consent before it can be saved. Tick the box, or choose Review or Manual mode.
              </p>
            ) : null}
          </div>
        ) : null}

        {form.mode === "AUTO" ? (
          <section aria-labelledby="readiness-title" className="space-y-3 rounded-md border p-4">
            <h4 id="readiness-title" className="text-sm font-semibold">
              Auto mode readiness
            </h4>
            {saved.readiness.canAutoApply ? (
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Ready to submit automatically
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Before Auto mode can submit anything:</p>
                <ul className="space-y-2" aria-label="Still to do">
                  {saved.readiness.blockers.map((b) => {
                    const link = blockerLink(b);
                    return (
                      <li key={b} className="flex items-start gap-2 text-sm">
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                        <span>
                          {b}
                          {link ? (
                            <>
                              {" "}
                              <Link href={link.href} className="font-medium text-primary underline-offset-4 hover:underline">
                                {link.label}
                              </Link>
                            </>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {dirty ? <p className="text-xs text-muted-foreground">Checked against your saved settings - save your changes to check again.</p> : null}
            {providers ? (
              autoCapable.length ? (
                <p className="text-sm">
                  Automatic submission is possible on this server for:{" "}
                  {autoCapable.map((p, i) => (
                    <span key={p.id}>
                      {i ? ", " : ""}
                      <span className="font-medium">{p.label}</span>
                      {p.capabilities.AUTO_APPLY.status === "EXPERIMENTAL" ? " (experimental)" : ""}
                    </span>
                  ))}
                  . Every other source hands the application back to you.
                </p>
              ) : (
                <p className="text-sm text-amber-900 dark:text-amber-100">
                  None of the job sources you enabled can submit applications automatically on this server, so applications will wait for you or be handed back to you.
                </p>
              )
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
