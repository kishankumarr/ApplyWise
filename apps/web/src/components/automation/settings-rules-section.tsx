"use client";

import { APPLY_METHODS, type ApplyMethod, type JobWorkMode } from "@applywise/types";
import { Card, CardContent, cn, Input, NativeSelect } from "@applywise/ui";
import { APPLY_METHOD_LABELS, WORK_MODE_LABELS } from "@/lib/format";
import { ControlTagInput } from "./control-tag-input";
import { Field, FieldError, joinIds, SectionHeading, ToggleRow } from "./control-shared";
import { LIST_LIMITS, type FormApi, type RulesForm } from "./settings-form";

/** "unknown" is not selectable: jobs that do not state a work mode always wait for review when a filter is set. */
const WORK_MODE_CHOICES: JobWorkMode[] = ["remote", "hybrid", "onsite"];
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "CAD", "AUD"];

type ListKey = keyof typeof LIST_LIMITS;

function CheckboxGroup<T extends string>({
  id,
  legend,
  hint,
  options,
  labels,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  legend: string;
  hint: string;
  options: readonly T[];
  labels: Record<string, string>;
  value: T[];
  onChange: (next: T[]) => void;
  error?: string;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled} aria-describedby={joinIds(`${id}-hint`, error && `${id}-error`)}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const checked = value.includes(o);
          return (
            <label
              key={o}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                checked ? "border-primary bg-primary/5" : "hover:bg-accent/40",
              )}
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={checked}
                onChange={(e) => onChange(e.target.checked ? options.filter((x) => x === o || value.includes(x)) : value.filter((x) => x !== o))}
              />
              {labels[o] ?? o}
            </label>
          );
        })}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  );
}

export function SettingsRulesSection({ api }: { api: FormApi }) {
  const { form, setRule, error, disabled } = api;
  const r = form.rules;

  const tags = (key: ListKey, label: string, hint: string, placeholder: string) => (
    <ControlTagInput
      id={`rule-${key}`}
      label={label}
      hint={hint}
      placeholder={placeholder}
      value={r[key]}
      onChange={(v) => setRule(key, v as RulesForm[typeof key])}
      maxItems={LIST_LIMITS[key].items}
      maxLength={LIST_LIMITS[key].length}
      error={error(`rules.${key}`)}
      disabled={disabled}
    />
  );

  return (
    <Card role="region" aria-labelledby="rules-title">
      <SectionHeading
        id="rules-title"
        step={4}
        title="Rules"
        description="Deterministic filters applied after matching. They can ignore a job or hold it for your review; they never make a weak match look stronger."
      />
      <CardContent className="space-y-6">
        <div className="grid gap-5 md:grid-cols-2">
          {tags("targetTitles", "Target job titles", "Jobs with other titles are only recommended, never prepared.", "e.g. Frontend Engineer")}
          {tags("excludedTitles", "Excluded job titles", "Jobs whose title contains any of these are ignored.", "e.g. Intern, Manager")}
          {tags("preferredCompanies", "Preferred companies", "Recommended jobs at these companies are raised to review.", "e.g. Acme")}
          {tags("excludedCompanies", "Excluded companies", "Jobs at these companies are always ignored.", "e.g. your current employer")}
        </div>

        <div className="space-y-3">
          {tags("requiredSkills", "Required skills", "Jobs that do not ask for these skills are ignored.", "e.g. React, TypeScript")}
          <fieldset className="space-y-2" disabled={disabled || r.requiredSkills.length === 0}>
            <legend className="text-sm font-medium">The job must ask for</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "any", label: "At least one of them" },
                  { value: "all", label: "All of them" },
                ] as const
              ).map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                    r.requiredSkillsMode === o.value ? "border-primary bg-primary/5" : "hover:bg-accent/40",
                    r.requiredSkills.length === 0 && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name="required-skills-mode"
                    className="h-4 w-4 accent-primary"
                    value={o.value}
                    checked={r.requiredSkillsMode === o.value}
                    onChange={() => setRule("requiredSkillsMode", o.value)}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <ToggleRow
            id="allow-missing-mandatory"
            checked={r.allowMissingMandatorySkills}
            onChange={(v) => setRule("allowMissingMandatorySkills", v)}
            disabled={disabled}
            title="Allow auto-apply when a mandatory skill is missing"
            description="Off (recommended): jobs asking for a must-have skill you have no verified evidence for always wait for your review."
          />
          <Field
            id="max-experience-gap"
            label="Maximum experience gap (years)"
            hint="Ignore jobs asking for more than this many years above your experience."
            error={error("rules.maxExperienceGapYears")}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                min={0}
                max={20}
                step={0.5}
                disabled={disabled}
                value={r.maxExperienceGapYears}
                onChange={(e) => setRule("maxExperienceGapYears", e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Field
            id="location-mode"
            label="Location"
            hint={r.locationMode === "preferences" ? "Jobs that clearly do not fit your location preferences are ignored." : "No location rule."}
            error={error("rules.locationMode")}
          >
            {(p) => (
              <NativeSelect {...p} disabled={disabled} value={r.locationMode} onChange={(e) => setRule("locationMode", e.target.value === "any" ? "any" : "preferences")}>
                <option value="preferences">Must fit my profile's location preferences</option>
                <option value="any">Any location</option>
              </NativeSelect>
            )}
          </Field>
          <CheckboxGroup<JobWorkMode>
            id="work-modes"
            legend="Allowed work modes"
            hint="None ticked = every work mode. With a filter, jobs that do not state a work mode wait for your review."
            options={WORK_MODE_CHOICES}
            labels={WORK_MODE_LABELS}
            value={r.allowedWorkModes}
            onChange={(v) => setRule("allowedWorkModes", v)}
            error={error("rules.allowedWorkModes")}
            disabled={disabled}
          />
        </div>

        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="text-sm font-medium">Minimum salary (yearly)</legend>
          <div className="grid max-w-md grid-cols-[1fr_7rem] gap-3">
            <Field id="min-salary" label={<span className="sr-only">Amount</span>} error={error("rules.minSalary")}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  placeholder="No minimum"
                  value={r.minSalary}
                  onChange={(e) => setRule("minSalary", e.target.value)}
                  aria-describedby={joinIds(p["aria-describedby"], "min-salary-help")}
                />
              )}
            </Field>
            <Field id="salary-currency" label={<span className="sr-only">Currency</span>} error={error("rules.salaryCurrency")}>
              {(p) => (
                <>
                  <Input
                    {...p}
                    list="salary-currencies"
                    maxLength={3}
                    autoComplete="off"
                    spellCheck={false}
                    className="uppercase"
                    value={r.salaryCurrency}
                    onChange={(e) => setRule("salaryCurrency", e.target.value.toUpperCase())}
                  />
                  <datalist id="salary-currencies">
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
          </div>
          <p id="min-salary-help" className="text-xs text-muted-foreground">
            Jobs whose stated maximum is below this are ignored. Jobs without a salary, or in another currency, are not filtered out. For example 1200000 = 12 LPA.
          </p>
        </fieldset>

        <CheckboxGroup<ApplyMethod>
          id="apply-methods"
          legend="Allowed application types"
          hint="None ticked = every application type."
          options={APPLY_METHODS}
          labels={APPLY_METHOD_LABELS}
          value={r.allowedApplyMethods}
          onChange={(v) => setRule("allowedApplyMethods", v)}
          error={error("rules.allowedApplyMethods")}
          disabled={disabled}
        />
      </CardContent>
    </Card>
  );
}
