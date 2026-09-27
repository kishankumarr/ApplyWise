"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCheck, Info, Loader2 } from "lucide-react";
import { APPLICATION_STATUSES, AUTOMATION_DECISION_LABELS, AUTOMATION_DECISIONS, JOB_PLATFORMS, type AutomationDecision } from "@applywise/types";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  Checkbox,
  cn,
  EmptyState,
  Input,
  Label,
  NativeSelect,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@applywise/ui";
import { pageCountOf, Pager } from "@/components/pager";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView, FeedKind, JobListItem, JobListResponse } from "@/lib/client-types";
import { platformLabel, relativeDate, scoreVariant, statusLabel, timeAgo, WORK_MODE_LABELS, yoeRange } from "@/lib/format";
import { useDebouncedValue } from "@/lib/hooks";
import { PageHeader } from "../page-header";
import { SourcesStrip } from "../sources/sources-strip";
import { useJobFeeds } from "../sources/use-job-feeds";
import { ApplicationStatusBadge, AutomationDecisionBadge, EmptyValue } from "./automation-badges";
import type { ApplicationTarget } from "./automation-confirm-dialogs";
import { STATUS_FILTER_GROUPS } from "./automation-labels";
import { AutomationModeNote, useAutomationSettings } from "./automation-mode-note";
import { JobRowActions } from "./automation-row-actions";
import { ImportJobDialog } from "./import-job-dialog";
import { salaryRange, shortLocations } from "./match-format";
import { SkillChips } from "./match-skill-chips";
import { ProviderCredit } from "./provider-credit";

// The confirmations are only needed after a click on Approve / Apply: load their code on demand.
const ApproveConfirmDialog = dynamic(() => import("./automation-confirm-dialogs").then((m) => m.ApproveConfirmDialog), { ssr: false });
const ApplyConfirmDialog = dynamic(() => import("./automation-confirm-dialogs").then((m) => m.ApplyConfirmDialog), { ssr: false });

type Sort = "score" | "posted" | "company" | "title" | "found";
const SORTS: Sort[] = ["score", "found", "posted", "company", "title"];
const SORT_LABELS: Record<Sort, string> = { score: "Best match", found: "Recently found", posted: "Recently posted", company: "Company (A-Z)", title: "Job title (A-Z)" };
const defaultOrder = (s: Sort) => (s === "company" || s === "title" ? "asc" : "desc");

interface Filters {
  q: string;
  platform: string;
  company: string;
  location: string;
  workMode: string;
  minYoe: string;
  maxYoe: string;
  postedWithinDays: string;
  minScore: string;
  status: string;
  /** "" = any, "NONE" = not evaluated, or an AutomationDecision. */
  decision: string;
  savedOnly: boolean;
  includeIgnored: boolean;
  newOnly: boolean;
  feedId: string;
}

const EMPTY: Filters = {
  q: "",
  platform: "",
  company: "",
  location: "",
  workMode: "",
  minYoe: "",
  maxYoe: "",
  postedWithinDays: "",
  minScore: "",
  status: "",
  decision: "",
  savedOnly: false,
  includeIgnored: false,
  newOnly: false,
  feedId: "",
};
/** Typed filters: the list waits until typing pauses (one request per pause, not per keystroke). Selects and checkboxes apply at once. */
const TYPED_FILTERS: (keyof Filters)[] = ["q", "company", "minYoe", "maxYoe", "minScore"];
const MAX_SELECT = 10;
const PAGE_SIZE = 25;

/** Adds the given filters to the query string. Every filter is applied on the server (the automation decision too). */
function setFilterParams(p: URLSearchParams, f: Filters, keys: (keyof Filters)[]) {
  for (const k of keys) {
    const v = f[k];
    if (typeof v === "boolean") {
      if (v) p.set(k, "true");
    } else if (v) p.set(k, v);
  }
  return p;
}

/** Any filter narrows the list (sort order does not count). */
const hasFilters = (f: Filters) => (Object.keys(EMPTY) as (keyof Filters)[]).some((k) => f[k] !== EMPTY[k]);

const isDecision = (v: string | null): v is AutomationDecision => !!v && (AUTOMATION_DECISIONS as readonly string[]).includes(v);

const FEED_KIND_SHORT: Record<FeedKind, string> = { MAILBOX: "job alert", COMPANY_BOARD: "company board", SEARCH: "saved search" };
const SNIPPET_TITLE = "Only a short summary is available (from a job alert or search), so the match score is based on that summary. Open the job and use the ApplyWise browser extension to add the full description.";

/**
 * Presets from the URL (links from notifications, sources and the dashboard): /jobs?new=true, /jobs?feedId=...,
 * /jobs?sort=found, /jobs?status=WAITING_APPROVAL, /jobs?decision=AUTO_ELIGIBLE (or NONE).
 */
function presetsFrom(params: URLSearchParams): { filters: Filters; sort: Sort } {
  const sort = SORTS.find((s) => s === params.get("sort")) ?? "score";
  const status = params.get("status");
  const decision = params.get("decision");
  return {
    filters: {
      ...EMPTY,
      newOnly: params.get("new") === "true" || params.get("newOnly") === "true",
      feedId: params.get("feedId") ?? "",
      status: status && (status === "NONE" || (APPLICATION_STATUSES as readonly string[]).includes(status)) ? status : "",
      decision: decision === "NONE" || isDecision(decision) ? decision : "",
    },
    sort,
  };
}

export function JobsInbox() {
  return (
    <Suspense
      fallback={
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      }
    >
      <JobsInboxContent />
    </Suspense>
  );
}

/** Platform plus the provider credit (required by search-API terms) or the automatic source that found the job. */
function SourceLine({ job }: { job: JobListItem }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>{platformLabel(job.platform)}</span>
      {job.attributionUrl && job.attribution ? (
        <span title={job.feed?.label}>
          · <ProviderCredit attribution={job.attribution} url={job.attributionUrl} />
        </span>
      ) : job.feed ? (
        <span title={job.feed.label}>· via {FEED_KIND_SHORT[job.feed.kind] ?? "source"}</span>
      ) : null}
    </span>
  );
}

interface JobRowProps {
  job: JobListItem;
  selected: boolean;
  /** Status from a Prepare request that the list does not show yet. */
  pendingStatus: string | null;
  preparing: boolean;
  stateBusy: boolean;
  onSelect: (job: JobListItem, on: boolean) => void;
  onPrepare: (job: JobListItem) => void;
  onConfirm: (kind: "approve" | "apply", job: JobListItem) => void;
  onSetState: (v: { id: string; saved?: boolean; ignored?: boolean }) => void;
}

/** One job match. Memoized: it re-renders only when its own job, selection or busy state changes. */
const JobRow = memo(function JobRow({ job: j, selected, pendingStatus, preparing, stateBusy, onSelect, onPrepare, onConfirm, onSetState }: JobRowProps) {
  const salary = salaryRange(j.salaryMin, j.salaryMax, j.currency);
  const yoe = yoeRange(j.experienceMinYears, j.experienceMaxYears);
  const workMode = WORK_MODE_LABELS[j.workMode] ?? j.workMode;
  const locations = j.locations.length ? shortLocations(j.locations) : "Location not stated";
  return (
    <TableRow data-testid="job-row" data-new={j.isNew ? "true" : undefined} data-state={selected ? "selected" : undefined}>
      <TableCell className="align-top lg:align-middle">
        <Checkbox checked={selected} onCheckedChange={(c) => onSelect(j, c === true)} aria-label={`Select ${j.title} at ${j.company}`} />
      </TableCell>
      <TableCell className="align-top lg:align-middle">
        <Badge
          variant={scoreVariant(j.scoreLabel)}
          data-testid="job-score"
          title={j.descriptionLevel === "SNIPPET" ? "Estimated resume-to-job match, based on a short summary only" : "Estimated resume-to-job match"}
        >
          {j.score ?? "—"}
        </Badge>
      </TableCell>
      <TableCell className="min-w-[11rem] max-w-[24rem] align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={`/jobs/${j.id}`} className="font-medium hover:underline" data-testid="job-title">
            {j.title}
          </Link>
          {j.isNew ? (
            <Badge variant="info" className="px-1.5 py-0 text-[10px]" data-testid="job-new">
              New
            </Badge>
          ) : null}
          {j.isDemo ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              Demo
            </Badge>
          ) : null}
          {j.descriptionLevel === "SNIPPET" ? (
            <Badge variant="outline" className="cursor-help px-1.5 py-0 text-[10px]" title={SNIPPET_TITLE} data-testid="job-snippet">
              Summary only
            </Badge>
          ) : null}
        </div>
        <div className="text-sm text-muted-foreground" data-testid="job-company">
          {j.company}
        </div>
        {/* Stacked details: each item hides once its own column is shown. */}
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <li className="xl:hidden">
            <SourceLine job={j} />
          </li>
          <li className="xl:hidden" title={j.locations.join(", ") || undefined}>
            {locations} · {workMode}
          </li>
          {salary ? <li className="2xl:hidden">{salary}</li> : null}
          {yoe !== "—" ? <li className="2xl:hidden">{yoe}</li> : null}
          <li className="min-[1800px]:hidden">posted {relativeDate(j.postedAt)}</li>
        </ul>
        {j.applicationStatus || pendingStatus || j.automationDecision ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 lg:hidden">
            {j.automationDecision ? <AutomationDecisionBadge decision={j.automationDecision} /> : null}
            {j.applicationStatus ? <ApplicationStatusBadge status={j.applicationStatus} /> : pendingStatus ? <span className="text-xs">{pendingStatus}</span> : null}
          </div>
        ) : null}
        {j.matchedSkills.length || j.missingSkills.length ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-[1800px]:hidden">
            <SkillChips skills={j.matchedSkills} tone="matched" showEmpty={false} />
            <SkillChips skills={j.missingSkills} tone="missing" showEmpty={false} />
          </div>
        ) : null}
      </TableCell>
      <TableCell className="hidden max-w-[12rem] text-sm xl:table-cell">
        <span title={j.locations.join(", ") || undefined}>{j.locations.length ? shortLocations(j.locations) : <EmptyValue label="Location not stated" />}</span>
        <div className="text-xs text-muted-foreground min-[1800px]:hidden">{workMode}</div>
      </TableCell>
      <TableCell className="hidden text-sm min-[1800px]:table-cell">{workMode}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-sm 2xl:table-cell">{salary || <EmptyValue label="Salary not stated" />}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-sm 2xl:table-cell">{yoe === "—" ? <EmptyValue label="Experience not stated" /> : yoe}</TableCell>
      <TableCell className="hidden max-w-[12rem] text-sm xl:table-cell">
        <div>{platformLabel(j.platform)}</div>
        {j.attributionUrl && j.attribution ? (
          <ProviderCredit attribution={j.attribution} url={j.attributionUrl} />
        ) : j.attribution ? (
          <div className="truncate text-xs text-muted-foreground" title={j.feed ? `${j.attribution} · ${j.feed.label}` : j.attribution}>
            {j.attribution}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-sm min-[1800px]:table-cell">
        {relativeDate(j.postedAt)}
        {j.feed ? <div className="text-xs text-muted-foreground">found {timeAgo(j.foundAt)}</div> : null}
      </TableCell>
      <TableCell className="hidden max-w-[12rem] min-[1800px]:table-cell">
        <SkillChips skills={j.matchedSkills} tone="matched" />
      </TableCell>
      <TableCell className="hidden max-w-[12rem] min-[1800px]:table-cell">
        <SkillChips skills={j.missingSkills} tone="missing" />
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <AutomationDecisionBadge decision={j.automationDecision} />
      </TableCell>
      <TableCell className="hidden text-sm lg:table-cell">
        {j.applicationStatus ? (
          <ApplicationStatusBadge status={j.applicationStatus} />
        ) : pendingStatus ? (
          <span aria-live="polite">{pendingStatus}</span>
        ) : (
          <EmptyValue label="Not started" />
        )}
      </TableCell>
      <TableCell className="align-top text-right lg:align-middle">
        <JobRowActions
          job={j}
          preparing={preparing}
          stateBusy={stateBusy}
          onPrepare={() => onPrepare(j)}
          onApprove={() => void onConfirm("approve", j)}
          onApply={() => void onConfirm("apply", j)}
          onToggleSaved={() => onSetState({ id: j.id, saved: !j.saved })}
          onToggleIgnored={() => onSetState({ id: j.id, ignored: !j.ignored })}
        />
      </TableCell>
    </TableRow>
  );
});

function JobsInboxContent() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const paramsKey = params.toString();
  const [appliedParams, setAppliedParams] = useState(paramsKey);
  const [filters, setFilters] = useState<Filters>(() => presetsFrom(new URLSearchParams(paramsKey)).filters);
  const [sort, setSort] = useState<Sort>(() => presetsFrom(new URLSearchParams(paramsKey)).sort);
  const [order, setOrder] = useState<"asc" | "desc">(() => defaultOrder(presetsFrom(new URLSearchParams(paramsKey)).sort));
  /** Selected jobs (kept across pages, so the Prepare wording can still see jobs that are not on the current page). */
  const [selected, setSelected] = useState<JobListItem[]>([]);
  const [batchStatus, setBatchStatus] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ kind: "approve" | "apply"; target: ApplicationTarget } | null>(null);
  /** The page belongs to the list it was chosen for: any change of filters, sort or order starts again at page 1. */
  const [paging, setPaging] = useState({ list: "", page: 1 });
  const listTop = useRef<HTMLDivElement>(null);

  // A link to /jobs?... while already on /jobs (e.g. a notification) applies its presets again.
  if (appliedParams !== paramsKey) {
    setAppliedParams(paramsKey);
    const p = presetsFrom(new URLSearchParams(paramsKey));
    setFilters(p.filters);
    setSort(p.sort);
    setOrder(defaultOrder(p.sort));
    setPaging({ list: "", page: 1 });
  }

  const typed = useMemo(() => setFilterParams(new URLSearchParams(), filters, TYPED_FILTERS).toString(), [filters]);
  const debouncedTyped = useDebouncedValue(typed);
  // Clearing the typed filters (Reset, a preset link) applies at once.
  const appliedTyped = typed ? debouncedTyped : "";
  const listQuery = useMemo(() => {
    const p = setFilterParams(new URLSearchParams({ sort, order, pageSize: String(PAGE_SIZE) }), filters, (Object.keys(EMPTY) as (keyof Filters)[]).filter((k) => !TYPED_FILTERS.includes(k)));
    for (const [k, v] of new URLSearchParams(appliedTyped)) p.set(k, v);
    return p.toString();
  }, [filters, sort, order, appliedTyped]);
  const page = paging.list === listQuery ? paging.page : 1;
  const query = `${listQuery}&page=${page}`;

  const { data, isLoading, isFetching, isPlaceholderData, error } = useQuery({
    queryKey: ["jobs", query],
    queryFn: () => api<JobListResponse>(`/api/jobs?${query}`),
    placeholderData: keepPreviousData,
  });
  const view = data?.view;
  const sources = data?.sources;
  const settings = useAutomationSettings().data;
  const items = data?.items ?? [];
  // The list shrank below the current page (e.g. the last jobs on it were ignored): go to the new last page.
  const lastPage = data && !isPlaceholderData ? pageCountOf(data.total, PAGE_SIZE) : null;
  if (lastPage !== null && page > lastPage) setPaging({ list: listQuery, page: lastPage });
  const pastLastPage = !!data && data.items.length === 0 && data.total > 0;
  const selectedIds = useMemo(() => new Set(selected.map((j) => j.id)), [selected]);

  const goToPage = (p: number) => {
    setPaging({ list: listQuery, page: p });
    const el = listTop.current;
    if (el && el.getBoundingClientRect().top < 0) {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  };

  // Source filter options (only needed once the user has sources).
  const feeds = useJobFeeds({ enabled: (sources?.total ?? 0) > 0 || !!filters.feedId });

  /** Background preparation / execution finishes after the request returns: refresh the list a few times. */
  const refreshSoon = () => {
    for (const delay of [1500, 4000, 8000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ["jobs"] }), delay);
  };

  /**
   * Honest wording for "Prepare": an application the automation already created in Auto mode may be approved by
   * the Auto policy and submitted once every safety check passes. Everything else waits for the user.
   */
  const prepareMessage = (jobs: JobListItem[]) => {
    const autoPossible = settings ? settings.mode === "AUTO" : true;
    const mayAutoSubmit = autoPossible && jobs.some((j) => j.applicationId && j.automationDecision === "AUTO_ELIGIBLE");
    return mayAutoSubmit
      ? "Preparation started. Auto mode: an auto-eligible application may be submitted automatically once every safety check passes; everything else waits for your review."
      : "Preparation started. The drafts wait for your review - nothing is submitted.";
  };

  const setState = useMutation({
    mutationFn: ({ id, ...body }: { id: string; saved?: boolean; ignored?: boolean }) => api(`/api/jobs/${id}/state`, { method: "PATCH", body }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      if (v.ignored === true) {
        toast.success(filters.includeIgnored ? "Job ignored." : "Job ignored - it is hidden from your matches.", {
          action: {
            label: "Undo",
            onClick: () => {
              api(`/api/jobs/${v.id}/state`, { method: "PATCH", body: { ignored: false } })
                .then(() => qc.invalidateQueries({ queryKey: ["jobs"] }))
                .catch((e: unknown) => toast.error(errorMessage(e)));
            },
          },
        });
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const viewPrefs = useMutation({
    // markSeen sends the time the list was computed, so jobs that arrived since then stay new.
    mutationFn: (body: { showDemoJobs?: boolean | null; markSeen?: true; asOf?: string }) => api("/api/jobs/view-prefs", { method: "PATCH", body }),
    onSuccess: (_r, body) => {
      if (body.markSeen) {
        toast.success("All caught up. New jobs will be marked again as they arrive.");
        setFilters((f) => ({ ...f, newOnly: false }));
      } else toast.success(body.showDemoJobs ? "Demo jobs are shown." : "Demo jobs are hidden.");
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const batch = useMutation({
    mutationFn: (jobIds: string[]) => api<{ results: { jobId: string; status?: string; error?: string }[] }>("/api/applications/batch-prepare", { body: { jobIds } }),
    onSuccess: (r, jobIds) => {
      const next: Record<string, string> = {};
      for (const x of r.results) next[x.jobId] = x.error ? `Failed: ${x.error}` : statusLabel(x.status ?? "PREPARING");
      setBatchStatus(next);
      // The current page's copy of a job is the freshest; selections from other pages use the copy from when they were ticked.
      const known = new Map([...selected, ...(data?.items ?? [])].map((j) => [j.id, j]));
      setSelected([]);
      toast.success(prepareMessage(jobIds.map((id) => known.get(id)).filter((j): j is JobListItem => !!j)));
      refreshSoon();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const prepareOne = useMutation({
    mutationFn: (job: JobListItem) => api<{ applicationId: string; status: string }>(`/api/jobs/${job.id}/prepare-application`, { body: {} }),
    onSuccess: (r, job) => {
      setBatchStatus((s) => ({ ...s, [job.id]: statusLabel(r.status) }));
      toast.success(prepareMessage([job]));
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      refreshSoon();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const changeSort = (s: Sort) => {
    setSort(s);
    setOrder(defaultOrder(s));
  };
  const toggleSort = (s: Sort) => {
    if (sort === s) setOrder(order === "asc" ? "desc" : "asc");
    else changeSort(s);
  };
  const ariaSort = (...s: Sort[]) => (s.includes(sort) ? (order === "asc" ? "ascending" : "descending") : undefined);
  const sortButton = (s: Sort, label: string, ariaLabel: string) => (
    <button type="button" onClick={() => toggleSort(s)} className="inline-flex items-center gap-0.5 font-medium hover:text-foreground" aria-label={ariaLabel}>
      {label} {sort === s ? order === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" /> : null}
    </button>
  );
  const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  // Row callbacks are stable, so the memoized rows do not re-render while typing in a filter or ticking another row.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const toggleSelect = useCallback((job: JobListItem, on: boolean) => {
    if (on && selectedRef.current.length >= MAX_SELECT) {
      toast.error(`You can select up to ${MAX_SELECT} jobs at a time.`);
      return;
    }
    setSelected((s) => (on ? (s.some((x) => x.id === job.id) ? s : [...s, job]) : s.filter((x) => x.id !== job.id)));
  }, []);
  const openConfirm = useCallback(async (kind: "approve" | "apply", j: JobListItem) => {
    if (!j.applicationId || !j.applicationStatus) return;
    const target: ApplicationTarget = { applicationId: j.applicationId, jobId: j.id, title: j.title, company: j.company, status: j.applicationStatus };
    if (kind === "approve") {
      // In Review/Auto mode approving is the Review-mode approval: the server also queues the submission, so the
      // confirmation must be the one that says so ("Approve & apply"), never "nothing is submitted".
      // WAITING_APPROVAL is only reached in Review/Auto mode; otherwise the application's own mode decides.
      if (j.applicationStatus !== "WAITING_APPROVAL") {
        const applicationId = j.applicationId;
        try {
          const app = await qc.fetchQuery({ queryKey: ["application", applicationId], queryFn: () => api<ApplicationView>(`/api/applications/${applicationId}`), staleTime: 10_000 });
          if (app.automation.mode !== "REVIEW" && app.automation.mode !== "AUTO") {
            setConfirm({ kind: "approve", target });
            return;
          }
        } catch (e) {
          toast.error(errorMessage(e));
          return;
        }
      }
      setConfirm({ kind: "apply", target });
      return;
    }
    setConfirm({ kind, target });
  }, [qc]);

  const feedOptions = feeds.data?.feeds ?? [];
  const newCount = view?.newCount ?? 0;
  const decisionLabel = filters.decision === "NONE" ? "Not evaluated" : isDecision(filters.decision) ? AUTOMATION_DECISION_LABELS[filters.decision] : "";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Job matches"
        description={data?.disclaimer ?? "Jobs from every source, ranked by estimated resume-to-job match."}
        actions={
          <>
            <ImportJobDialog />
            <Button onClick={() => batch.mutate(selected.map((j) => j.id))} disabled={selected.length === 0 || batch.isPending}>
              {batch.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Prepare applications ({selected.length}/{MAX_SELECT})
            </Button>
          </>
        }
      />

      {sources ? <SourcesStrip sources={sources} /> : null}
      <AutomationModeNote settings={settings} />

      {view?.demoAvailable && view.showDemo && view.ownJobs === 0 ? (
        <Alert variant="info" data-testid="demo-notice">
          <Info className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>These are demo jobs so you can try ApplyWise. They disappear automatically when your own jobs arrive.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="grid gap-3 pt-5 sm:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1 lg:col-span-2">
            <Label htmlFor="f-q">Search title, company or description</Label>
            <Input id="f-q" value={filters.q} onChange={(e) => setF({ q: e.target.value })} placeholder="e.g. React, video, Canvas" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-platform">Platform</Label>
            <NativeSelect id="f-platform" value={filters.platform} onChange={(e) => setF({ platform: e.target.value })}>
              <option value="">All</option>
              {JOB_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {platformLabel(p)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-company">Company</Label>
            <Input id="f-company" value={filters.company} onChange={(e) => setF({ company: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-location">Location</Label>
            <NativeSelect id="f-location" value={filters.location} onChange={(e) => setF({ location: e.target.value })}>
              <option value="">Any</option>
              {["Bengaluru", "Hyderabad", "Pune", "Mumbai", "Gurgaon", "Chennai", "Remote - India", "Remote - Global"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-mode">Work mode</Label>
            <NativeSelect id="f-mode" value={filters.workMode} onChange={(e) => setF({ workMode: e.target.value })}>
              <option value="">Any</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">Onsite</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-minyoe">Min YOE</Label>
            <Input id="f-minyoe" type="number" min={0} value={filters.minYoe} onChange={(e) => setF({ minYoe: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-maxyoe">Max YOE</Label>
            <Input id="f-maxyoe" type="number" min={0} value={filters.maxYoe} onChange={(e) => setF({ maxYoe: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-posted">Posted within</Label>
            <NativeSelect id="f-posted" value={filters.postedWithinDays} onChange={(e) => setF({ postedWithinDays: e.target.value })}>
              <option value="">Any time</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-score">Min match score</Label>
            <Input id="f-score" type="number" min={0} max={100} value={filters.minScore} onChange={(e) => setF({ minScore: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-decision">Automation decision</Label>
            <NativeSelect id="f-decision" value={filters.decision} onChange={(e) => setF({ decision: e.target.value })}>
              <option value="">Any</option>
              {AUTOMATION_DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {AUTOMATION_DECISION_LABELS[d]}
                </option>
              ))}
              <option value="NONE">Not evaluated</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-status">Application status</Label>
            <NativeSelect id="f-status" value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">Any</option>
              <option value="NONE">Not started</option>
              {STATUS_FILTER_GROUPS.map((g) =>
                g.statuses.length ? (
                  <optgroup key={g.label} label={g.label}>
                    {g.statuses.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </NativeSelect>
          </div>
          {feedOptions.length || filters.feedId ? (
            <div className="space-y-1">
              <Label htmlFor="f-feed">Source</Label>
              <NativeSelect id="f-feed" value={filters.feedId} onChange={(e) => setF({ feedId: e.target.value })}>
                <option value="">All sources</option>
                {feedOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
                {filters.feedId && !feedOptions.some((f) => f.id === filters.feedId) ? <option value={filters.feedId}>{feeds.isLoading ? "Loading..." : "Selected source"}</option> : null}
              </NativeSelect>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="f-sort">Sort by</Label>
            <NativeSelect id="f-sort" value={sort} onChange={(e) => changeSort(e.target.value as Sort)}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 sm:col-span-2 lg:col-span-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={filters.newOnly} onCheckedChange={(c) => setF({ newOnly: c === true })} aria-label="New only" /> New only
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={filters.savedOnly} onCheckedChange={(c) => setF({ savedOnly: c === true })} aria-label="Saved only" /> Saved only
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={filters.includeIgnored} onCheckedChange={(c) => setF({ includeIgnored: c === true })} aria-label="Show ignored" /> Show ignored
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(EMPTY);
                setPaging({ list: "", page: 1 });
              }}
            >
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
      {data ? (
        <div ref={listTop} className="flex scroll-mt-4 flex-wrap items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {data.total} jobs {decisionLabel ? `with the decision “${decisionLabel}” ` : ""}
            {newCount > 0 ? `· ${newCount} new ` : ""}
            {isFetching ? "· updating…" : ""}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            {newCount > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => viewPrefs.mutate({ markSeen: true, asOf: view?.asOf })} disabled={viewPrefs.isPending}>
                <CheckCheck aria-hidden="true" /> Mark all as seen ({newCount})
              </Button>
            ) : null}
            {view?.demoAvailable && !view.showDemo ? (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => viewPrefs.mutate({ showDemoJobs: true })} disabled={viewPrefs.isPending}>
                Show demo jobs
              </Button>
            ) : view?.demoAvailable && view.showDemo && view.ownJobs > 0 ? (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => viewPrefs.mutate({ showDemoJobs: false })} disabled={viewPrefs.isPending}>
                Hide demo jobs
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {isLoading || pastLastPage ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">Loading job matches…</span>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        filters.newOnly ? (
          <EmptyState title="No new jobs right now" description="New jobs from your job sources appear here automatically. Untick “New only” to see everything." />
        ) : view && view.ownJobs === 0 && !hasFilters(filters) ? (
          <EmptyState
            title="No jobs yet"
            description={
              (sources?.total ?? 0) > 0
                ? "Your job sources are being checked. New jobs will appear here automatically."
                : "Connect your job alerts or follow companies and jobs will arrive here automatically."
            }
            action={
              <Link href="/jobs/sources" className={cn(buttonVariants({ size: "sm" }))}>
                {(sources?.total ?? 0) > 0 ? "Manage job sources" : "Set up job sources"}
              </Link>
            }
          />
        ) : decisionLabel ? (
          <EmptyState
            title={`No jobs with the decision “${decisionLabel}”`}
            description="The automation decides on new jobs from your sources on each run. Choose another decision or reset the filters."
            action={
              <Button size="sm" variant="outline" onClick={() => setF({ decision: "" })}>
                Show every decision
              </Button>
            }
          />
        ) : (
          <EmptyState title="No jobs match these filters" description="Try widening your filters or import a job." />
        )
      ) : data ? (
        <>
          <Card>
            <Table data-testid="jobs-table">
              <caption className="sr-only">Job matches, ranked by estimated resume-to-job match</caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Select</span>
                  </TableHead>
                  <TableHead aria-sort={ariaSort("score")}>{sortButton("score", "Match", "Sort by match score")}</TableHead>
                  <TableHead aria-sort={ariaSort("title", "company")} className="min-w-[11rem]">
                    <span className="inline-flex flex-wrap items-center gap-x-1">
                      {sortButton("title", "Job", "Sort by title")}
                      <span aria-hidden="true">/</span>
                      {sortButton("company", "Company", "Sort by company")}
                    </span>
                  </TableHead>
                  <TableHead className="hidden xl:table-cell">Location</TableHead>
                  <TableHead className="hidden min-[1800px]:table-cell">Work mode</TableHead>
                  <TableHead className="hidden 2xl:table-cell">Salary</TableHead>
                  <TableHead className="hidden 2xl:table-cell">Experience</TableHead>
                  <TableHead className="hidden xl:table-cell">Source</TableHead>
                  <TableHead aria-sort={ariaSort("posted")} className="hidden min-[1800px]:table-cell">
                    {sortButton("posted", "Posted", "Sort by posted date")}
                  </TableHead>
                  <TableHead className="hidden min-[1800px]:table-cell">Matched skills</TableHead>
                  <TableHead className="hidden min-[1800px]:table-cell">Missing skills</TableHead>
                  <TableHead className="hidden lg:table-cell">Decision</TableHead>
                  <TableHead className="hidden lg:table-cell">Application</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    selected={selectedIds.has(j.id)}
                    pendingStatus={(!j.applicationStatus && batchStatus[j.id]) || null}
                    preparing={prepareOne.isPending && prepareOne.variables?.id === j.id}
                    stateBusy={setState.isPending && setState.variables?.id === j.id}
                    onSelect={toggleSelect}
                    onPrepare={prepareOne.mutate}
                    onConfirm={openConfirm}
                    onSetState={setState.mutate}
                  />
                ))}
              </TableBody>
            </Table>
          </Card>
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={goToPage} busy={isFetching} label="Job matches pages" />
        </>
      ) : null}

      {/* Mounted only while a confirmation is open; the key gives every application a fresh, unticked confirmation. */}
      {confirm?.kind === "approve" ? <ApproveConfirmDialog key={`approve-${confirm.target.applicationId}`} target={confirm.target} onClose={() => setConfirm(null)} /> : null}
      {confirm?.kind === "apply" ? <ApplyConfirmDialog key={`apply-${confirm.target.applicationId}`} target={confirm.target} onClose={() => setConfirm(null)} onQueued={refreshSoon} /> : null}
    </div>
  );
}
