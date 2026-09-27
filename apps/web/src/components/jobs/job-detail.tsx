"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, ExternalLink, Info, RefreshCw } from "lucide-react";
import { IMPORT_METHOD_INTEGRATION_CLASS, type JobImportMethod } from "@applywise/types";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { JobDetailResponse } from "@/lib/client-types";
import { APPLY_METHOD_LABELS, platformLabel, relativeDate, WORK_MODE_LABELS, yoeRange } from "@/lib/format";
import { ApplicationWorkspace } from "../applications/application-workspace";
import { JobAutomationPanel } from "./automation-panel";
import { salaryRange } from "./match-format";
import { MatchReportCard, RequirementMatrix } from "./match-report";
import { ProviderCredit } from "./provider-credit";
import { QuestionnaireForm } from "./questionnaire-form";

export function JobDetail({ initial }: { initial: JobDetailResponse }) {
  const qc = useQueryClient();
  const jobId = initial.job.id;
  const { data } = useQuery({ queryKey: ["job", jobId], queryFn: () => api<JobDetailResponse>(`/api/jobs/${jobId}`), initialData: initial });
  const [applicationId, setApplicationId] = useState<string | null>(initial.application?.id ?? null);
  const job = data.job;
  const snippet = data.descriptionLevel === "SNIPPET";
  const salary = salaryRange(job.salaryMin, job.salaryMax, job.currency);
  const sources = data.sources ?? [];
  // Job-search API providers (Adzuna, Himalayas, ...) are credited wherever their jobs are shown.
  const credited = sources.filter((s) => s.attributionUrl);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["job", jobId] });
  const save = useMutation({
    mutationFn: () => api(`/api/jobs/${jobId}/state`, { method: "PATCH", body: { saved: !data.state.saved } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const analyze = useMutation({
    mutationFn: () => api(`/api/jobs/${jobId}/analyze`, { body: {} }),
    onSuccess: () => {
      refresh();
      toast.success("Match recalculated.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const prepare = useMutation({
    mutationFn: () => api<{ applicationId: string }>(`/api/jobs/${jobId}/prepare-application`, { body: {} }),
    onSuccess: (r) => {
      setApplicationId(r.applicationId);
      void qc.invalidateQueries({ queryKey: ["application", r.applicationId] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Preparing drafts for your review. Nothing will be submitted.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{platformLabel(job.platform)}</Badge>
            {job.isDemo ? <Badge variant="warning">Demo content</Badge> : null}
            <span>{APPLY_METHOD_LABELS[job.applyMethod]}</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold" data-testid="job-detail-title">
            {job.title}
          </h1>
          <p className="text-muted-foreground">
            {job.company} · {job.location.join(", ") || "Location not stated"} · {WORK_MODE_LABELS[job.workMode]} · {yoeRange(job.experienceMinYears, job.experienceMaxYears)}
            {salary ? ` · ${salary}` : ""} · posted {relativeDate(job.postedAt)}
          </p>
          {sources.length > 1 ? (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="job-found-via">
              Found via{" "}
              {sources.map((s, i) => (
                <span key={i}>
                  {i > 0 ? (i === sources.length - 1 ? " and " : ", ") : null}
                  {s.attributionUrl || s.sourceUrl ? (
                    <a href={s.attributionUrl ?? s.sourceUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">
                      {s.attribution}
                    </a>
                  ) : (
                    s.attribution
                  )}
                </span>
              ))}
            </p>
          ) : credited.length ? (
            <p className="mt-1" data-testid="job-found-via">
              <ProviderCredit attribution={credited[0]!.attribution} url={credited[0]!.attributionUrl} className="text-sm" />
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => save.mutate()} aria-pressed={data.state.saved}>
            {data.state.saved ? <BookmarkCheck /> : <Bookmark />} {data.state.saved ? "Saved" : "Save"}
          </Button>
          {job.applyUrl ? (
            <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-accent">
              <ExternalLink className="h-4 w-4" /> Official page
            </a>
          ) : null}
          {!applicationId ? (
            <Button onClick={() => prepare.mutate()} disabled={prepare.isPending} data-testid="prepare-application">
              Prepare application
            </Button>
          ) : (
            <Link href={`/applications/${applicationId}`} className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              Open application
            </Link>
          )}
        </div>
      </div>

      {snippet ? (
        <Alert variant="info" data-testid="snippet-notice">
          <Info className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Summary only</AlertTitle>
          <AlertDescription>
            Only a short summary is available for this job (from a job alert or search). Open the job page and click the ApplyWise browser extension to add the full description - this job will be
            updated, not duplicated, and its match score recalculated.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          {data.match ? <RequirementMatrix report={data.match} /> : null}
          <QuestionnaireForm jobId={jobId} onCompleted={refresh} />
          {applicationId ? <ApplicationWorkspace applicationId={applicationId} /> : null}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Job description</CardTitle>
              {snippet ? <CardDescription>Short summary from a job alert or search. The full description is on the job page.</CardDescription> : null}
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap text-sm leading-6" data-testid="job-description">
                {job.description}
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {data.match ? (
            <>
              <MatchReportCard report={data.match} disclaimer={data.disclaimer} />
              <Button variant="ghost" size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
                <RefreshCw /> Recalculate match
              </Button>
            </>
          ) : (
            <Alert>
              <AlertDescription>Complete your profile to see a match estimate.</AlertDescription>
            </Alert>
          )}
          <JobAutomationPanel applicationId={applicationId} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Source & application method</CardTitle>
              <CardDescription>Where this job came from and how to apply.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {sources.length > 1 ? <p className="font-medium">Found via {sources.length} sources</p> : null}
              {sources.map((s, i) => (
                <div key={i}>
                  <p>
                    {s.attributionUrl ? (
                      <ProviderCredit attribution={s.attribution} url={s.attributionUrl} className="text-sm text-foreground" />
                    ) : s.sourceUrl ? (
                      <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                        {s.attribution} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    ) : (
                      s.attribution
                    )}
                  </p>
                  {s.attributionUrl && s.sourceUrl ? (
                    <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline">
                      View the original listing <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Integration: {IMPORT_METHOD_INTEGRATION_CLASS[s.importMethod as JobImportMethod] ?? s.integrationClass} · imported {relativeDate(s.createdAt)}
                  </p>
                </div>
              ))}
              <p>
                <strong>Apply via:</strong> {APPLY_METHOD_LABELS[job.applyMethod]}
              </p>
              {job.applyUrl ? (
                <p className="break-all">
                  <strong>Official apply URL:</strong> {job.applyUrl}
                </p>
              ) : null}
              {job.hrEmail ? (
                <p>
                  <strong>HR email:</strong> {job.hrEmail}
                </p>
              ) : null}
              {job.applicationInstructions ? <p className="text-muted-foreground">{job.applicationInstructions}</p> : null}
              {job.requiredSkills.length ? (
                <div>
                  <p className="font-medium">Required skills</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {job.requiredSkills.map((s) => (
                      <Badge key={s.canonicalName} variant={s.mandatory ? "destructive" : "secondary"}>
                        {s.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {job.preferredSkills.length ? (
                <div>
                  <p className="font-medium">Preferred skills</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {job.preferredSkills.map((s) => (
                      <Badge key={s.canonicalName} variant="outline">
                        {s.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
