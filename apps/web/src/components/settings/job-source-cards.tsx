"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, Lock, Send, TriangleAlert } from "lucide-react";
import type { AutomationSettingsView, ProviderSourceCard } from "@applywise/types";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardHeader, CardTitle, cn, EmptyState, Skeleton, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import { platformLabel, plural } from "@/lib/format";
import { JobSourceConnection } from "./job-source-connection";
import {
  applicationSummary,
  canSubmitAutomatically,
  CAPABILITY_ROWS,
  CAPABILITY_STATUS,
  CAPABILITY_STATUS_ORDER,
  CARD_STATUS,
  needsAttention,
  PROVIDER_KIND_LABELS,
} from "./job-source-labels";
import { AUTOMATION_SETTINGS_KEY, nextEnabledProviders, PROVIDERS_KEY, useAutomationSettings, useProviderCards } from "./job-source-queries";

type Filter = "all" | "auto" | "manual" | "attention";

const FILTERS: { key: Filter; label: string; test: (c: ProviderSourceCard) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "auto", label: "Can auto-apply", test: canSubmitAutomatically },
  { key: "manual", label: "Manual only", test: (c) => c.manualOnly },
  { key: "attention", label: "Needs attention", test: needsAttention },
];

const LAST_ONE = "Keep at least one job source enabled. To stop the automation altogether, turn automation off instead.";

export function JobSourceCards({ initialCards }: { initialCards?: ProviderSourceCard[] }) {
  const qc = useQueryClient();
  const cards = useProviderCards(initialCards);
  const settings = useAutomationSettings();
  const [filter, setFilter] = useState<Filter>("all");

  const list = useMemo(() => cards.data ?? [], [cards.data]);
  const allIds = useMemo(() => list.map((c) => c.id), [list]);

  const toggle = useMutation({
    mutationFn: (v: { card: ProviderSourceCard; enable: boolean; enabledProviders: string[] }) =>
      api<AutomationSettingsView>("/api/automation/settings", { method: "PUT", body: { enabledProviders: v.enabledProviders } }),
    onSuccess: (view, v) => {
      qc.setQueryData(AUTOMATION_SETTINGS_KEY, view);
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      // Toasts are announced to screen readers by the toaster's own live region.
      toast.success(v.enable ? `${v.card.label} is enabled for automation.` : `${v.card.label} is off: the automation will not prepare or submit applications for its jobs.`);
    },
    onError: (e, v) => toast.error(`Could not update ${v.card.label}: ${errorMessage(e)}`),
  });

  const enabledProviders = settings.data?.enabledProviders;
  const isEnabled = (card: ProviderSourceCard): boolean => {
    if (toggle.isPending && toggle.variables?.card.id === card.id) return toggle.variables.enable;
    if (enabledProviders) return enabledProviders.length === 0 || enabledProviders.includes(card.id);
    return card.enabledForAutomation;
  };

  const onToggle = (card: ProviderSourceCard, enable: boolean) => {
    if (!enabledProviders || toggle.isPending) return;
    const next = nextEnabledProviders(enabledProviders, allIds, card.id, enable);
    if (!next) {
      toast.error(LAST_ONE);
      return;
    }
    toggle.mutate({ card, enable, enabledProviders: next });
  };

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]!;
  const visible = list.filter(active.test);
  const autoCount = list.filter(canSubmitAutomatically).length;
  const enabledCount = list.filter(isEnabled).length;
  const attentionCount = list.filter(needsAttention).length;

  return (
    <div className="space-y-6">
      <Explainer />

      {cards.error && !cards.data ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load your job sources</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{errorMessage(cards.error)}</p>
            <Button size="sm" variant="outline" onClick={() => void cards.refetch()} disabled={cards.isFetching}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {settings.error && !settings.data ? (
        <Alert variant="warning">
          <AlertTitle>Automation settings unavailable</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>The &quot;Enabled for automation&quot; switches cannot be changed until your automation settings load. {errorMessage(settings.error)}</p>
            <Button size="sm" variant="outline" onClick={() => void settings.refetch()} disabled={settings.isFetching}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {cards.isLoading ? (
        <div className="space-y-4" aria-busy="true">
          <span className="sr-only" role="status">
            Loading job sources...
          </span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : null}

      {cards.data ? (
        <>
          <h2 className="sr-only">Job sources on this server</h2>
          <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-4 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4" data-testid="job-sources-summary">
            <span className="font-medium">{plural(list.length, "job source")}</span>
            <span>{enabledCount === list.length ? "All enabled for automation" : `${enabledCount} enabled for automation`}</span>
            <span className="text-muted-foreground">{autoCount === 0 ? "None can submit applications automatically on this server" : `${autoCount} can submit applications automatically on this server`}</span>
            {attentionCount ? (
              <span className="flex items-center gap-1.5 font-medium text-destructive">
                <TriangleAlert className="h-4 w-4" aria-hidden="true" /> {attentionCount === 1 ? "1 needs your attention" : `${attentionCount} need your attention`}
              </span>
            ) : null}
          </div>

          <StatusLegend />

          <div className="space-y-2">
            <div role="group" aria-label="Filter job sources" className="flex flex-wrap gap-2">
              {FILTERS.map((f) => {
                const pressed = filter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setFilter(f.key)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      pressed ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                    )}
                  >
                    {f.label}
                    <span className={cn("rounded-full px-1.5 text-xs tabular-nums", pressed ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>
                      {list.filter(f.test).length}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="sr-only" aria-live="polite" role="status">
              {`Showing ${visible.length} of ${list.length} job sources.`}
            </p>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={filter === "attention" ? "Nothing needs your attention" : "No job sources match this filter"}
              description={filter === "auto" ? "No source can submit applications automatically on this server. ApplyWise still prepares every application and hands it to you." : undefined}
              action={
                <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
                  Show all sources
                </Button>
              }
            />
          ) : (
            <ul className="space-y-4" aria-label="Job sources">
              {visible.map((card) => (
                <li key={card.id}>
                  <JobSourceCard
                    card={card}
                    enabled={isEnabled(card)}
                    switchDisabled={!enabledProviders || toggle.isPending}
                    saving={toggle.isPending && toggle.variables?.card.id === card.id}
                    onToggle={(enable) => onToggle(card, enable)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

function Explainer() {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold leading-none tracking-tight">How job sources work</h2>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">You never need to keep job sites open.</span> ApplyWise&apos;s background workers check your sources on a schedule, discover new jobs
            and match them against your verified profile.
          </li>
          <li>
            Where a platform allows automated applications, the automation can submit them for you - in Review mode only after you approve, in Auto mode only with your
            consent and within your daily limit. In Manual mode nothing is ever submitted.
          </li>
          <li>
            Where a platform does not allow automated applications, ApplyWise prepares everything - the best resume variant, cover letter and screening answers from your
            verified information - and hands it over to you. The browser extension can prefill the application form; you submit it yourself.
          </li>
          <li>Every status below is what this server can actually do right now.</li>
        </ul>
      </CardContent>
    </Card>
  );
}

function StatusLegend() {
  return (
    <details className="group rounded-md border px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        What do the capability statuses mean?
      </summary>
      <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
        {CAPABILITY_STATUS_ORDER.map((s) => (
          <div key={s} className="contents">
            <dt>
              <Badge variant={CAPABILITY_STATUS[s].tone}>{CAPABILITY_STATUS[s].label}</Badge>
            </dt>
            <dd className="text-muted-foreground">{CAPABILITY_STATUS[s].meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function EnabledSwitch({ checked, disabled, saving, labelledBy, describedBy, onChange }: { checked: boolean; disabled: boolean; saving: boolean; labelledBy: string; describedBy: string; onChange: (v: boolean) => void }) {
  return (
    <span className="inline-flex items-center gap-2">
      {saving ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-primary" : "bg-muted-foreground/40",
        )}
      >
        <span aria-hidden="true" className={cn("pointer-events-none block h-5 w-5 rounded-full bg-background shadow transition-transform", checked ? "translate-x-5" : "translate-x-0")} />
      </button>
    </span>
  );
}

function JobSourceCard({
  card,
  enabled,
  switchDisabled,
  saving,
  onToggle,
}: {
  card: ProviderSourceCard;
  enabled: boolean;
  switchDisabled: boolean;
  saving: boolean;
  onToggle: (enable: boolean) => void;
}) {
  const ids = useId();
  const status = CARD_STATUS[card.cardStatus];
  const titleId = `${ids}-title`;
  const switchLabelId = `${ids}-switch`;
  const switchHintId = `${ids}-switch-hint`;
  const discovery = card.capabilities.DISCOVERY.status;
  const showFeeds = card.feeds > 0 || card.jobsFound > 0 || discovery === "AVAILABLE" || discovery === "LIMITED";
  const automatic = canSubmitAutomatically(card);

  return (
    <Card data-testid={`job-source-${card.id}`}>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id={titleId} className="text-base">
              {card.label}
            </CardTitle>
            <Badge variant={status.tone} data-testid="source-card-status">
              <span className="sr-only">Status: </span>
              {status.label}
            </Badge>
            {card.demo ? <Badge variant="info">Demo content</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {PROVIDER_KIND_LABELS[card.kind] ?? card.kind}
            {card.platforms.length > 1 ? ` · covers ${card.platforms.map(platformLabel).join(", ")}` : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:items-end">
          <div className="flex items-center gap-2">
            <span id={switchLabelId} className="text-sm font-medium">
              Enabled for automation
              <span className="sr-only"> - {card.label}</span>
            </span>
            <EnabledSwitch checked={enabled} disabled={switchDisabled} saving={saving} labelledBy={switchLabelId} describedBy={switchHintId} onChange={onToggle} />
          </div>
          <span id={switchHintId} className="text-xs text-muted-foreground sm:text-right">
            {enabled ? "On: its jobs are matched and prepared by the automation." : "Off: the automation skips its jobs."}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", automatic ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100" : "bg-muted/50")}>
          {automatic ? <Send className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <span>{applicationSummary(card)}</span>
        </p>

        <dl className="divide-y rounded-md border" aria-label={`${card.label} capabilities`}>
          {CAPABILITY_ROWS.map(({ key, label, hint }) => {
            const cap = card.capabilities[key];
            const s = CAPABILITY_STATUS[cap.status];
            return (
              <div key={key} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-4" data-testid={`capability-${key}`}>
                <dt className="text-sm font-medium">
                  {label}
                  {hint ? <span className="block text-xs font-normal text-muted-foreground">{hint}</span> : null}
                </dt>
                <dd className="min-w-0 space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant={s.tone}>{s.label}</Badge>
                    {cap.via ? <span className="text-muted-foreground">via {cap.via}</span> : null}
                  </div>
                  {cap.note ? <p className="text-muted-foreground">{cap.note}</p> : null}
                </dd>
              </div>
            );
          })}
        </dl>

        {card.notes.length || card.externalRequirements.length ? (
          <div className="grid gap-4 text-sm md:grid-cols-2">
            {card.notes.length ? (
              <div className="space-y-1">
                <h4 className="font-medium">Notes</h4>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {card.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {card.externalRequirements.length ? (
              <div className="space-y-1">
                <h4 className="font-medium">What is needed for the missing parts</h4>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {card.externalRequirements.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {card.auth === "api_key" || card.auth === "oauth_token" ? <JobSourceConnection card={card} /> : null}
        {card.auth === "not_supported" ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Account connection not available - job-platform passwords are never stored.
          </p>
        ) : null}

        {showFeeds ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-sm" data-testid="source-feeds">
            <span>{plural(card.feeds, "automatic source")}</span>
            <span>{plural(card.jobsFound, "job")} found</span>
            {!card.demo ? (
              <Link href="/jobs/sources" className="font-medium text-primary underline-offset-4 hover:underline">
                {card.feeds ? "Manage automatic sources" : "Add an automatic source"}
                <span className="sr-only"> for {card.label}</span>
              </Link>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
