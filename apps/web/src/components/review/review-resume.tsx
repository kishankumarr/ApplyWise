"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  cn,
  toast,
} from "@applywise/ui";
import type { ReviewQueueItem } from "@applywise/types";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView, ResumeRankingView } from "@/lib/client-types";
import { invalidateRelated } from "./review-shared";

const AUTO = "__automatic__";

/** The resume the automation selected (or the user chose), with a "Change" control. */
export function ResumeSection({ item, headingId }: { item: ReviewQueueItem; headingId: string }) {
  const [open, setOpen] = useState(false);
  const r = item.resume;
  const label = r.label ?? (r.reason ? "Resume variant from your profile" : "Not selected yet");
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Resume
        </h3>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={`Change the resume for ${item.job.title}`}>
          Change
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{label}</p>
        {r.score != null ? <Badge variant="outline">Fit {r.score}/100</Badge> : null}
        {r.overridden ? <Badge variant="info">Overridden</Badge> : null}
      </div>
      {r.reason ? <p className="text-sm text-muted-foreground">{r.reason}</p> : null}
      {open ? <ResumeChoiceDialog applicationId={item.applicationId} jobTitle={item.job.title} open={open} onOpenChange={setOpen} /> : null}
    </section>
  );
}

function ResumeChoiceDialog({ applicationId, jobTitle, open, onOpenChange }: { applicationId: string; jobTitle: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const ranking = useQuery({
    queryKey: ["application-resume", applicationId],
    queryFn: () => api<ResumeRankingView>(`/api/applications/${applicationId}/resume`),
    enabled: open,
    staleTime: 0,
  });
  const [choice, setChoice] = useState<string | null>(null);

  const rows = useMemo(() => [...(ranking.data?.ranking ?? [])].sort((a, b) => b.score - a.score), [ranking.data]);
  const current = useMemo(() => {
    const s = ranking.data?.selection;
    if (!s || !s.overridden) return AUTO;
    const row = rows.find((x) => (s.resumeId != null && x.resumeId === s.resumeId) || (s.versionId != null && x.versionId === s.versionId));
    return row?.resumeId ?? AUTO;
  }, [ranking.data, rows]);
  const value = choice ?? current;

  const save = useMutation({
    mutationFn: (resumeId: string | null) => api<ApplicationView>(`/api/applications/${applicationId}/resume`, { method: "PUT", body: { resumeId } }),
    onSuccess: (app, resumeId) => {
      qc.setQueryData(["application", applicationId], app);
      void invalidateRelated(qc);
      toast.success(resumeId === null ? "Back to automatic resume selection." : `Resume changed to “${app.resumeSelection.label ?? "your choice"}”.`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const best = rows[0];
  const groupName = `resume-choice-${applicationId}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose the resume</DialogTitle>
          <DialogDescription>
            For {jobTitle}. Each resume is scored on the job requirements it covers with your verified evidence.
          </DialogDescription>
        </DialogHeader>
        <div aria-live="polite" aria-busy={ranking.isLoading}>
          {ranking.isLoading ? (
            <Spinner label="Loading your resumes" className="text-sm text-muted-foreground" />
          ) : ranking.error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {errorMessage(ranking.error)}
                <Button size="sm" variant="outline" onClick={() => void ranking.refetch()}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No parsed resumes yet. Upload one on the{" "}
              <Link href="/resume" className="underline">
                Resume
              </Link>{" "}
              page.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="sr-only">Resume for this application</legend>
              <ChoiceRow name={groupName} value={AUTO} checked={value === AUTO} onSelect={setChoice} disabled={save.isPending}>
                <span className="font-medium">Automatic</span>
                <span className="block text-xs text-muted-foreground">
                  Always use the best-matching resume{best ? ` - currently “${best.label}” (${best.score}/100)` : ""}.
                </span>
              </ChoiceRow>
              {rows.map((r) => {
                const total = r.matchedSkills.length + r.missingSkills.length;
                return (
                  <ChoiceRow key={r.resumeId} name={groupName} value={r.resumeId} checked={value === r.resumeId} onSelect={setChoice} disabled={save.isPending}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.label}</span>
                      <Badge variant="outline">{r.score}/100</Badge>
                      {r.roleAligned ? <Badge variant="success">Role-aligned</Badge> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {total ? `Covers ${r.matchedSkills.length} of ${total} requirements.` : "No skill requirements to compare."}
                      {r.missingSkills.length ? ` Missing: ${r.missingSkills.slice(0, 6).join(", ")}${r.missingSkills.length > 6 ? "…" : ""}` : ""}
                    </span>
                  </ChoiceRow>
                );
              })}
            </fieldset>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(value === AUTO ? null : value)} disabled={!ranking.data || rows.length === 0 || value === current || save.isPending}>
            {save.isPending ? "Saving…" : "Use this resume"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceRow({
  name,
  value,
  checked,
  onSelect,
  disabled,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/40",
        checked && "border-primary bg-accent/30",
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onSelect(value)} disabled={disabled} className="mt-1 h-4 w-4 accent-primary" />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}
