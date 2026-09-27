"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import type { AutomationSettingsView, ProviderSourceCard } from "@applywise/types";
import type { AutomationSettingsUpdateInput } from "@applywise/validation";
import { Alert, AlertDescription, Button, toast } from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { ControlHowItWorks } from "./control-how-it-works";
import { invalidateAutomationData, PROVIDERS_KEY, PROVIDERS_URL, SETTINGS_KEY, SETTINGS_URL } from "./control-shared";
import { ControlStatusCard } from "./control-status-card";
import {
  diffValues,
  errorKeyFor,
  type FieldErrors,
  type FormApi,
  formsEqual,
  fromView,
  mapServerFieldErrors,
  parseForm,
  rebase,
  type RulesForm,
  type SettingsForm,
  type TopKey,
} from "./settings-form";
import { SettingsModeSection } from "./settings-mode-section";
import { SettingsProvidersSection } from "./settings-providers-section";
import { SettingsRulesSection } from "./settings-rules-section";
import { SettingsThresholdsSection } from "./settings-thresholds-section";

interface Draft {
  /** The saved settings the form was last reconciled with. */
  base: AutomationSettingsView;
  form: SettingsForm;
}

function without(errors: FieldErrors, key: string): FieldErrors {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export function ControlCenter({
  initialSettings,
  initialProviders,
  demoAvailable,
  maxDailyLimit,
}: {
  initialSettings: AutomationSettingsView;
  initialProviders: ProviderSourceCard[];
  demoAvailable: boolean;
  /** Operator cap (AUTOMATION_MAX_DAILY_LIMIT). */
  maxDailyLimit: number;
}) {
  const qc = useQueryClient();
  /** Poll quickly until this time (a run was just started and may not report `running` yet). */
  const fastUntil = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const consentRef = useRef<HTMLButtonElement>(null);

  const settingsQuery = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<AutomationSettingsView>(SETTINGS_URL),
    initialData: initialSettings,
    refetchInterval: (q) => (q.state.data?.status.running || Date.now() < fastUntil.current ? 4_000 : 30_000),
  });
  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => api<ProviderSourceCard[]>(PROVIDERS_URL),
    initialData: initialProviders,
  });
  const saved = settingsQuery.data;

  // ------------------------------------------------------------ draft (edited form) kept in sync with the server

  const [draft, setDraft] = useState<Draft>(() => ({ base: saved, form: fromView(saved) }));
  const seen = useRef(saved);
  useEffect(() => {
    if (saved === seen.current) return;
    seen.current = saved;
    // Fresh server data (polling, the ON/OFF switch, another tab): keep the user's unsaved edits, take the rest.
    setDraft((d) => ({ base: saved, form: rebase(d.form, fromView(d.base), fromView(saved)) }));
  }, [saved]);

  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState(false);

  const baseForm = useMemo(() => fromView(draft.base), [draft.base]);
  const baseValues = useMemo(() => parseForm(baseForm, { maxDailyLimit }).values, [baseForm, maxDailyLimit]);
  const parsed = useMemo(() => parseForm(draft.form, { maxDailyLimit, baseline: baseForm }), [draft.form, baseForm, maxDailyLimit]);
  const dirty = !formsEqual(draft.form, baseForm);

  const set = useCallback(<K extends TopKey>(key: K, value: SettingsForm[K]) => {
    setDraft((d) => ({ ...d, form: { ...d.form, [key]: value } }));
    setServerErrors((e) => without(e, errorKeyFor(key)));
    if (key === "mode" || key === "autoApplyConsent") setConsentError(false);
  }, []);
  const setRule = useCallback(<K extends keyof RulesForm>(key: K, value: RulesForm[K]) => {
    setDraft((d) => ({ ...d, form: { ...d.form, rules: { ...d.form.rules, [key]: value } } }));
    setServerErrors((e) => without(e, `rules.${key}`));
  }, []);
  const formApi: FormApi = {
    form: draft.form,
    set,
    setRule,
    error: (key) => parsed.errors[key] ?? serverErrors[key],
    disabled: false,
  };

  const focusFirstInvalid = () => {
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (!el) return;
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  // ------------------------------------------------------------ save

  const save = useMutation({
    mutationFn: ({ body }: { body: AutomationSettingsUpdateInput; form: SettingsForm }) => api<AutomationSettingsView>(SETTINGS_URL, { method: "PUT", body }),
    onSuccess: (view, { form: submitted }) => {
      seen.current = view;
      // Fields edited while the request was in flight stay edited; everything else takes the saved (normalised) value.
      setDraft((d) => ({ base: view, form: rebase(d.form, submitted, fromView(view)) }));
      qc.setQueryData(SETTINGS_KEY, view);
      setServerErrors({});
      setFormError(null);
      invalidateAutomationData(qc);
      if (view.mode === "AUTO" && !view.readiness.canAutoApply) toast.warning("Saved. Auto mode cannot submit anything yet - see the readiness checklist.");
      else if (view.mode === "MANUAL") toast.success("Saved. Manual mode: nothing is submitted for you.");
      else toast.success("Automation settings saved.");
    },
    onError: (e) => {
      if (e instanceof ApiClientError && e.fieldErrors && Object.keys(e.fieldErrors).length) {
        const { fields, other } = mapServerFieldErrors(e.fieldErrors);
        setServerErrors(fields);
        setFormError(other.length ? other.join(" ") : null);
        focusFirstInvalid();
      } else {
        setFormError(errorMessage(e));
      }
      toast.error(errorMessage(e));
    },
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (save.isPending) return;
    setFormError(null);
    if (Object.keys(parsed.errors).length) {
      toast.error("Please fix the highlighted fields first.");
      focusFirstInvalid();
      return;
    }
    // AUTO mode is never saved without the explicit consent (the server re-checks before any submission).
    if (parsed.values.mode === "AUTO" && !parsed.values.autoApplyConsent) {
      setConsentError(true);
      toast.error("Auto mode needs your consent. Tick the consent box, or choose Review or Manual mode.");
      requestAnimationFrame(() => {
        consentRef.current?.focus();
        consentRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return;
    }
    const body = diffValues(parsed.values, baseValues);
    if (Object.keys(body).length === 0) {
      setDraft((d) => ({ ...d, form: fromView(d.base) }));
      toast.info("No changes to save.");
      return;
    }
    save.mutate({ body, form: draft.form });
  };

  const discard = () => {
    setDraft((d) => ({ ...d, form: fromView(d.base) }));
    setServerErrors({});
    setFormError(null);
    setConsentError(false);
  };

  // ------------------------------------------------------------ runs

  const onRunStarted = useCallback(() => {
    fastUntil.current = Date.now() + 60_000;
  }, []);

  const running = saved.status.running;
  const lastRun = saved.status.lastRun;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      // A run just finished: jobs, applications, the review queue and the dashboard may all have changed.
      invalidateAutomationData(qc);
      if (lastRun) {
        const parts = [plural(lastRun.newJobs, "new job"), `${lastRun.applicationsPrepared} prepared`];
        if (lastRun.applicationsSubmitted) parts.push(`${lastRun.applicationsSubmitted} submitted`);
        const attention = lastRun.needsInformation + lastRun.manualActions;
        if (attention) parts.push(`${attention} need you`);
        if (lastRun.status === "FAILED") toast.error(`The automation run failed${lastRun.error ? `: ${lastRun.error}` : "."}`);
        else toast.success(`Automation run finished: ${parts.join(", ")}.`);
      }
    }
    wasRunning.current = running;
  }, [running, lastRun, qc]);

  const demoAdded = !!providersQuery.data?.some((p) => p.id === "demo" && p.feeds > 0);
  const parsedDaily = Number(draft.form.maxApplicationsPerDay);
  const consentLimit = Number.isInteger(parsedDaily) && parsedDaily >= 0 ? Math.min(parsedDaily, maxDailyLimit) : saved.status.dailyLimit;

  return (
    <div className="space-y-6">
      <ControlStatusCard settings={saved} demoAvailable={demoAvailable} demoAdded={demoAdded} unsavedChanges={dirty} onRunStarted={onRunStarted} />

      {settingsQuery.isError ? (
        <Alert variant="warning">
          <AlertDescription>Could not refresh the automation status ({errorMessage(settingsQuery.error)}). Showing the last known values; retrying automatically.</AlertDescription>
        </Alert>
      ) : null}

      <ControlHowItWorks />

      <form ref={formRef} onSubmit={onSubmit} noValidate aria-labelledby="automation-settings-title" className="space-y-6">
        <div>
          <h2 id="automation-settings-title" className="text-xl font-semibold tracking-tight">
            Settings
          </h2>
          <p className="text-sm text-muted-foreground">Change anything below, then save. The ON/OFF switch above takes effect immediately.</p>
        </div>

        <SettingsModeSection
          api={formApi}
          saved={saved}
          providers={providersQuery.data}
          consentError={consentError}
          consentRef={consentRef}
          dirty={dirty}
          dailyLimit={consentLimit}
        />
        <SettingsThresholdsSection api={formApi} maxDailyLimit={maxDailyLimit} />
        <SettingsProvidersSection
          api={formApi}
          providers={providersQuery.data}
          loading={providersQuery.isLoading}
          loadError={providersQuery.error}
          onRetry={() => void providersQuery.refetch()}
        />
        <SettingsRulesSection api={formApi} />

        <div className="sticky bottom-3 z-10 rounded-lg border bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p role="status" aria-live="polite" className="text-sm">
              {save.isPending ? (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Saving...
                </span>
              ) : dirty ? (
                <span className="font-medium">You have unsaved changes.</span>
              ) : (
                <span className="text-muted-foreground">All changes saved.</span>
              )}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={discard} disabled={!dirty || save.isPending}>
                Discard changes
              </Button>
              <Button type="submit" disabled={!dirty || save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
                Save changes
              </Button>
            </div>
          </div>
          {formError ? (
            <p role="alert" className="mt-2 text-sm font-medium text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
