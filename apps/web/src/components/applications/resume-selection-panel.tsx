"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, NativeSelect, Skeleton, Spinner, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView, ResumeRankingView } from "@/lib/client-types";
import { LOCKED_STATUSES } from "./application-labels";

/** The picker value for the stored selection ("" = automatic). Version-only candidates use "version:<id>" ids. */
function currentValue(sel: ApplicationView["resumeSelection"]): string {
  if (!sel.overridden) return "";
  if (sel.resumeId) return sel.resumeId;
  return sel.versionId ? `version:${sel.versionId}` : "";
}

/** Which resume variant is used for this application, why, and a picker to override it. */
export function ResumeSelectionPanel({ app, onChanged }: { app: ApplicationView; onChanged: (a: ApplicationView) => void }) {
  const sel = app.resumeSelection;
  const locked = LOCKED_STATUSES.includes(app.status);
  const ranking = useQuery({
    queryKey: ["application", app.id, "resume-ranking"],
    queryFn: () => api<ResumeRankingView>(`/api/applications/${app.id}/resume`),
    enabled: !locked,
  });
  const stored = currentValue(sel);
  const [choice, setChoice] = useState<string | null>(null);
  const value = choice ?? stored;

  const save = useMutation({
    mutationFn: (resumeId: string | null) => api<ApplicationView>(`/api/applications/${app.id}/resume`, { method: "PUT", body: { resumeId } }),
    onSuccess: (a, resumeId) => {
      setChoice(null);
      onChanged(a);
      toast.success(resumeId ? "Resume updated for this application." : "Back to automatic resume selection.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const hasSelection = !!(sel.resumeId || sel.versionId || sel.label);
  const rows = ranking.data?.ranking ?? [];

  return (
    <Card data-testid="resume-selection">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" aria-hidden="true" /> Resume for this job
        </CardTitle>
        <CardDescription>Chosen from your resume variants by the strongest verified evidence for this job. An approved tailored version, when there is one, is used instead.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {hasSelection ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{sel.label ?? "Selected resume"}</span>
              {sel.score != null ? <Badge variant="secondary">Score {Math.round(sel.score)}/100</Badge> : null}
              <Badge variant={sel.overridden ? "info" : "outline"}>{sel.overridden ? "Chosen by you" : "Automatic"}</Badge>
            </div>
            {sel.reason ? <p className="text-muted-foreground">{sel.reason}</p> : null}
          </div>
        ) : (
          <p className="text-muted-foreground">No resume selected yet - it is chosen when the application is prepared.</p>
        )}

        {locked ? (
          <p className="text-xs text-muted-foreground">This application was already sent or closed, so its resume can no longer be changed.</p>
        ) : ranking.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : ranking.error ? (
          <p className="text-destructive" role="alert">
            Could not load your resume variants: {errorMessage(ranking.error)}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            No resume variants to choose from yet. Your resumes are listed on the{" "}
            <a className="underline" href="/resume">
              Resume
            </a>{" "}
            page.
          </p>
        ) : (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (value !== stored) save.mutate(value || null);
            }}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={`resume-picker-${app.id}`}>Use this resume</Label>
              <NativeSelect id={`resume-picker-${app.id}`} value={value} onChange={(e) => setChoice(e.target.value)} disabled={save.isPending}>
                <option value="">Automatic (best match)</option>
                {rows.map((r) => (
                  <option key={r.resumeId} value={r.resumeId}>
                    {r.label} - {Math.round(r.score)}/100{r.roleAligned ? " - role aligned" : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" variant="outline" disabled={value === stored || save.isPending}>
              {save.isPending ? <Spinner label="Saving resume choice" /> : null}
              Save choice
            </Button>
          </form>
        )}

        {!locked && rows.length > 1 ? (
          <details className="rounded-md border p-2">
            <summary className="cursor-pointer select-none text-muted-foreground">Compare all {rows.length} variants</summary>
            <ul className="mt-2 space-y-2">
              {rows.map((r) => (
                <li key={r.resumeId} className="space-y-0.5">
                  <p>
                    <span className="font-medium">{r.label}</span> <span className="text-muted-foreground">- {Math.round(r.score)}/100</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.matchedSkills.length ? `Evidence for ${r.matchedSkills.slice(0, 6).join(", ")}${r.matchedSkills.length > 6 ? "…" : ""}` : "No matching skills found"}
                    {r.missingSkills.length ? `. Missing ${r.missingSkills.slice(0, 4).join(", ")}${r.missingSkills.length > 4 ? "…" : ""}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
