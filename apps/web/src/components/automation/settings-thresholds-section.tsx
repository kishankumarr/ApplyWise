"use client";

import { useEffect, useState } from "react";
import { Button, Card, CardContent, Input, NativeSelect } from "@applywise/ui";
import { Field, FieldError, frequencyLabel, SEARCH_FREQUENCIES, SectionHeading, ToggleRow } from "./control-shared";
import { hourLabel, isValidTimeZone, type FormApi } from "./settings-form";

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Colombo",
  "Asia/Karachi",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Africa/Johannesburg",
  "UTC",
];

function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const int = (s: string): number | null => (/^\s*\d+\s*$/.test(s) ? Number(s) : null);

/** Visual of the score bands, shown only when the three scores are valid and ordered. */
function ScoreBands({ recommend, min, auto }: { recommend: number; min: number; auto: number }) {
  const bands = [
    { label: "Ignored", range: recommend > 0 ? `0-${recommend - 1}` : null, width: recommend, className: "bg-muted-foreground/25" },
    { label: "Recommended", range: min > recommend ? `${recommend}-${min - 1}` : null, width: min - recommend, className: "bg-sky-400/70 dark:bg-sky-500/60" },
    { label: "Prepared for review", range: auto > min ? `${min}-${auto - 1}` : null, width: auto - min, className: "bg-amber-400/80 dark:bg-amber-500/60" },
    { label: "Auto-eligible", range: auto < 100 ? `${auto}-100` : "100", width: Math.max(100 - auto, 1), className: "bg-emerald-500/80 dark:bg-emerald-500/60" },
  ];
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full" aria-hidden="true">
        {bands.map((b) => (b.width > 0 ? <div key={b.label} className={b.className} style={{ width: `${b.width}%` }} /> : null))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="What each match score leads to">
        {bands
          .filter((b) => b.range)
          .map((b) => (
            <li key={b.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${b.className}`} />
              <span>
                {b.label}: <span className="font-medium tabular-nums text-foreground">{b.range}</span>
              </span>
            </li>
          ))}
      </ul>
      <p className="text-xs text-muted-foreground">Auto-eligible jobs are submitted automatically only in Auto mode; in the other modes they wait for you like any other prepared application.</p>
    </div>
  );
}

export function SettingsThresholdsSection({ api, maxDailyLimit }: { api: FormApi; maxDailyLimit: number }) {
  const { form, set, error, disabled } = api;
  const recommend = int(form.recommendScore);
  const min = int(form.minMatchScore);
  const auto = int(form.autoApplyScore);
  const bandsValid = recommend != null && min != null && auto != null && recommend <= min && min <= auto && auto <= 100;
  const frequency = Number(form.searchFrequencyMinutes);
  const frequencies: number[] = SEARCH_FREQUENCIES.includes(frequency as (typeof SEARCH_FREQUENCIES)[number]) ? [...SEARCH_FREQUENCIES] : [...SEARCH_FREQUENCIES, frequency].sort((a, b) => a - b);
  // Read after mount: the server renders with its own timezone, which would not match the browser's.
  const [device, setDevice] = useState<string | null>(null);
  useEffect(() => setDevice(deviceTimeZone()), []);
  const quietError = error("quietHours");

  return (
    <Card role="region" aria-labelledby="thresholds-title">
      <SectionHeading
        id="thresholds-title"
        step={2}
        title="Thresholds & limits"
        description="Match scores run from 0 to 100 and come from the deterministic matching engine. Rules below can still lower a decision, never raise a score."
      />
      <CardContent className="space-y-6">
        <fieldset className="space-y-4" disabled={disabled}>
          <legend className="text-sm font-semibold">Match scores</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="recommend-score" label="Show as recommended from" hint="Below this, jobs are ignored." error={error("recommendScore")}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={100} step={1} value={form.recommendScore} onChange={(e) => set("recommendScore", e.target.value)} />}
            </Field>
            <Field id="min-match-score" label="Minimum match score" hint="From here an application is prepared for you." error={error("minMatchScore")}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={100} step={1} value={form.minMatchScore} onChange={(e) => set("minMatchScore", e.target.value)} />}
            </Field>
            <Field id="auto-apply-score" label="Auto-apply score" hint="From here a job is eligible for automatic submission." error={error("autoApplyScore")}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={100} step={1} value={form.autoApplyScore} onChange={(e) => set("autoApplyScore", e.target.value)} />}
            </Field>
          </div>
          {bandsValid ? <ScoreBands recommend={recommend} min={min} auto={auto} /> : <p className="text-xs text-muted-foreground">Scores must satisfy: recommended ≤ minimum ≤ auto-apply.</p>}
        </fieldset>

        <fieldset className="space-y-4" disabled={disabled}>
          <legend className="text-sm font-semibold">Limits & schedule</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              id="max-per-day"
              label="Maximum applications per day"
              hint={`Automatic submissions per day in your timezone (this server allows up to ${maxDailyLimit}). 0 = never submit automatically.`}
              error={error("maxApplicationsPerDay")}
            >
              {(p) => (
                <Input {...p} type="number" inputMode="numeric" min={0} max={maxDailyLimit} step={1} value={form.maxApplicationsPerDay} onChange={(e) => set("maxApplicationsPerDay", e.target.value)} />
              )}
            </Field>
            <Field id="max-job-age" label="Maximum job age (days)" hint="Older postings are ignored." error={error("maxJobAgeDays")}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={365} step={1} value={form.maxJobAgeDays} onChange={(e) => set("maxJobAgeDays", e.target.value)} />}
            </Field>
            <Field id="search-frequency" label="Search frequency" hint="How often your sources are checked while automation is on." error={error("searchFrequencyMinutes")}>
              {(p) => (
                <NativeSelect {...p} value={form.searchFrequencyMinutes} onChange={(e) => set("searchFrequencyMinutes", e.target.value)}>
                  {frequencies.map((f) => (
                    <option key={f} value={String(f)}>
                      Every {frequencyLabel(f)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-3" disabled={disabled} aria-describedby={quietError ? "quiet-hours-error" : undefined}>
          <legend className="text-sm font-semibold">Quiet hours</legend>
          <ToggleRow
            id="quiet-hours-on"
            checked={form.quietHoursOn}
            onChange={(v) => set("quietHoursOn", v)}
            disabled={disabled}
            title="Pause automatic submissions and notifications during quiet hours"
            description="Discovery and preparation keep running; anything to submit waits until quiet hours end. Can cross midnight, e.g. 22:00 to 07:00."
          />
          <div className="grid max-w-md grid-cols-2 gap-4">
            <Field id="quiet-start" label="From">
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  step={60}
                  value={form.quietHoursStart}
                  disabled={!form.quietHoursOn || disabled}
                  aria-invalid={quietError ? true : undefined}
                  onChange={(e) => set("quietHoursStart", e.target.value)}
                />
              )}
            </Field>
            <Field id="quiet-end" label="To">
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  step={60}
                  value={form.quietHoursEnd}
                  disabled={!form.quietHoursOn || disabled}
                  aria-invalid={quietError ? true : undefined}
                  onChange={(e) => set("quietHoursEnd", e.target.value)}
                />
              )}
            </Field>
          </div>
          <FieldError id="quiet-hours-error" message={quietError} />
        </fieldset>

        <Field
          id="automation-timezone"
          label="Timezone"
          className="max-w-md"
          hint="Used for the daily limit, quiet hours and the daily summary. An IANA name such as Asia/Kolkata."
          error={error("timezone")}
        >
          {(p) => (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                {...p}
                list="automation-timezones"
                value={form.timezone}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                onChange={(e) => set("timezone", e.target.value)}
              />
              <datalist id="automation-timezones">
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              {device && device !== form.timezone.trim() && isValidTimeZone(device) ? (
                <Button type="button" variant="outline" size="sm" className="h-10 shrink-0" disabled={disabled} onClick={() => set("timezone", device)}>
                  Use {device}
                </Button>
              ) : null}
            </div>
          )}
        </Field>

        <fieldset className="space-y-3" disabled={disabled}>
          <legend className="text-sm font-semibold">Preparation & notifications</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <ToggleRow
              id="tailor-resume"
              checked={form.tailorResume}
              onChange={(v) => set("tailorResume", v)}
              disabled={disabled}
              title="Tailor my resume for each job"
              description="Adjusts the chosen resume to the job using only your verified facts."
            />
            <ToggleRow
              id="cover-letter"
              checked={form.generateCoverLetter}
              onChange={(v) => set("generateCoverLetter", v)}
              disabled={disabled}
              title="Write a cover letter"
              description="Drafted from your verified facts for each prepared application."
            />
            <ToggleRow
              id="email-applications"
              checked={form.allowEmailApplications}
              onChange={(v) => set("allowEmailApplications", v)}
              disabled={disabled}
              title="Allow email applications"
              description="When a job asks for applications by email, sends your prepared application to the employer's HR address - after your approval in Review mode, or automatically in Auto mode when every check passes. Never in Manual mode."
            />
            <ToggleRow
              id="notify-strong"
              checked={form.notifyStrongMatches}
              onChange={(v) => set("notifyStrongMatches", v)}
              disabled={disabled}
              title="Notify me about strong matches"
              description="A notification after a run finds jobs at or above your minimum match score (not during quiet hours)."
            />
          </div>
          <Field
            id="daily-summary"
            label="Daily summary"
            className="max-w-xs"
            hint="A summary notification of the day's jobs and applications at this hour, your timezone, while automation is on."
            error={error("dailySummaryHour")}
          >
            {(p) => (
              <NativeSelect {...p} value={form.dailySummaryHour} onChange={(e) => set("dailySummaryHour", e.target.value)}>
                <option value="">Off</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={String(h)}>
                    At {hourLabel(h)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </fieldset>
      </CardContent>
    </Card>
  );
}
