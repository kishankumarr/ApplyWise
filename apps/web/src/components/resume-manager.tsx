"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, NativeSelect, Skeleton, toast } from "@applywise/ui";
import { api, downloadFile, errorMessage } from "@/lib/api";
import type { ProfileView } from "@/lib/client-types";
import { useProfile } from "@/lib/hooks";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "./page-header";

interface VersionRow {
  id: string;
  kind: "ORIGINAL" | "EDITED" | "TAILORED";
  label: string;
  createdAt: string;
  approvedAt: string | null;
  applicationId: string | null;
}

/** Uploaded resume as returned by /api/profile; label/targetRoles are the variant fields used by resume selection. */
type ResumeRow = ProfileView["resumes"][number] & { label?: string | null; targetRoles?: string[] };

const LABEL_MAX = 80;
const MAX_ROLES = 10;
const ROLE_MAX = 120;

/** "Backend engineer, Platform engineer" -> trimmed, de-duplicated roles. */
function parseRoles(input: string): string[] {
  const seen = new Set<string>();
  return input
    .split(",")
    .map((r) => r.trim().replace(/\s+/g, " "))
    .filter((r) => {
      const k = r.toLowerCase();
      if (!r || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

function ResumeVariantEditor({ resume }: { resume: ResumeRow }) {
  const qc = useQueryClient();
  const ids = useId();
  const [saved, setSaved] = useState({ label: resume.label ?? "", roles: (resume.targetRoles ?? []).join(", ") });
  const [label, setLabel] = useState(saved.label);
  const [roles, setRoles] = useState(saved.roles);
  const [error, setError] = useState<string | null>(null);
  const labelChanged = label.trim() !== saved.label;
  const rolesChanged = parseRoles(roles).join(", ") !== saved.roles;
  const save = useMutation({
    mutationFn: (body: { label?: string | null; targetRoles?: string[] }) =>
      api<{ id: string; label: string | null; targetRoles: string[] }>(`/api/profile/resume/${encodeURIComponent(resume.id)}`, { method: "PATCH", body }),
    onSuccess: (r) => {
      const next = { label: r.label ?? "", roles: r.targetRoles.join(", ") };
      setSaved(next);
      setLabel(next.label);
      setRoles(next.roles);
      setError(null);
      toast.success(`Saved ${next.label || resume.originalFileName}. The automation uses it the next time it prepares an application.`);
      void qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e) => {
      setError(errorMessage(e));
      toast.error(errorMessage(e));
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const list = parseRoles(roles);
    const problem =
      list.length > MAX_ROLES ? `List at most ${MAX_ROLES} target roles.` : list.some((r) => r.length > ROLE_MAX) ? `Keep each role under ${ROLE_MAX} characters.` : null;
    setError(problem);
    // Only the fields that changed are sent, so an unchanged field is never overwritten.
    if (!problem) save.mutate({ ...(labelChanged ? { label: label.trim() || null } : {}), ...(rolesChanged ? { targetRoles: list } : {}) });
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border p-3" aria-label={`Variant details for ${resume.originalFileName}`} noValidate>
      <p className="truncate text-xs text-muted-foreground" title={resume.originalFileName}>
        {resume.originalFileName}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${ids}-label`}>Variant label</Label>
        <Input id={`${ids}-label`} value={label} maxLength={LABEL_MAX} placeholder="e.g. Backend resume" onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${ids}-roles`}>Target roles</Label>
        <Input
          id={`${ids}-roles`}
          value={roles}
          placeholder="e.g. Backend engineer, Platform engineer"
          onChange={(e) => setRoles(e.target.value)}
          aria-describedby={`${ids}-roles-hint${error ? ` ${ids}-err` : ""}`}
          aria-invalid={error ? true : undefined}
        />
        <p id={`${ids}-roles-hint`} className="text-xs text-muted-foreground">
          Comma separated, up to {MAX_ROLES}.
        </p>
      </div>
      <div aria-live="polite">
        {error ? (
          <p id={`${ids}-err`} className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={!(labelChanged || rolesChanged) || save.isPending}>
        {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        Save variant
      </Button>
    </form>
  );
}

function ResumeVariants({ resumes, loading }: { resumes: ResumeRow[] | undefined; loading: boolean }) {
  const parsed = resumes?.filter((r) => r.status === "PARSED") ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Resume variants</CardTitle>
        <CardDescription>The automation picks the variant with the strongest verified evidence for each job; you can override it on any application.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading ? <Skeleton className="h-32" /> : null}
        {!loading && parsed.length === 0 ? <p className="text-muted-foreground">Upload and parse a resume to label it as a variant.</p> : null}
        {parsed.map((r) => (
          // Remount when the server's saved values change so the fields show them.
          <ResumeVariantEditor key={`${r.id}:${r.label ?? ""}:${(r.targetRoles ?? []).join("|")}`} resume={r} />
        ))}
      </CardContent>
    </Card>
  );
}

export function ResumeManager() {
  const qc = useQueryClient();
  const profile = useProfile();
  const versions = useQuery({ queryKey: ["resume-versions"], queryFn: () => api<VersionRow[]>("/api/resumes/versions") });
  const [selected, setSelected] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string>("");
  const activeId = selected ?? versions.data?.[0]?.id ?? null;
  const version = useQuery({
    queryKey: ["resume-version", activeId],
    queryFn: () => api<{ id: string; label: string; html: string; text: string }>(`/api/resumes/versions/${activeId}`),
    enabled: !!activeId,
  });
  const other = useQuery({
    queryKey: ["resume-version", compareTo],
    queryFn: () => api<{ id: string; text: string }>(`/api/resumes/versions/${compareTo}`),
    enabled: !!compareTo,
  });
  const snapshot = useMutation({
    mutationFn: () => api<{ id: string; unchanged: boolean }>("/api/resumes/versions", { body: { label: `Edited profile ${new Date().toLocaleDateString("en-IN")}` } }),
    onSuccess: (r) => {
      toast.success(r.unchanged ? "No changes since the last version." : "New version saved from your verified profile.");
      void qc.invalidateQueries({ queryKey: ["resume-versions"] });
      setSelected(r.id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const exportAs = async (format: "pdf" | "docx" | "txt" | "html") => {
    if (!activeId) return;
    try {
      await downloadFile(`/api/resumes/${activeId}/export/${format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const diffLines = (() => {
    if (!compareTo || !other.data || !version.data) return null;
    const a = new Set(other.data.text.split("\n"));
    const b = new Set(version.data.text.split("\n"));
    return {
      added: version.data.text.split("\n").filter((l) => l.trim() && !a.has(l)),
      removed: other.data.text.split("\n").filter((l) => l.trim() && !b.has(l)),
    };
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Resume"
        description="Original upload, structured versions and tailored versions. Exports are single-column and ATS-readable; no ATS compatibility is guaranteed."
        actions={
          <Button variant="outline" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>
            Save verified profile as new version
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Uploaded files</CardTitle>
              <CardDescription>Encrypted at rest; downloads require sign-in.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {profile.data?.resumes.length ? (
                profile.data.resumes.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2">
                    <span className="truncate" title={r.originalFileName}>
                      {r.originalFileName}
                    </span>
                    <Button size="icon" variant="ghost" aria-label={`Download ${r.originalFileName}`} onClick={() => downloadFile(`/api/resumes/${r.id}/download`, "GET").catch((e) => toast.error(errorMessage(e)))}>
                      <Download />
                    </Button>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">No uploaded files.</p>
              )}
            </CardContent>
          </Card>
          <ResumeVariants resumes={profile.data?.resumes} loading={profile.isLoading} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Version history</CardTitle>
            </CardHeader>
            <CardContent>
              {versions.isLoading ? <Skeleton className="h-24" /> : null}
              <ul className="space-y-1">
                {versions.data?.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(v.id)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${v.id === activeId ? "bg-accent" : "hover:bg-accent/50"}`}
                      aria-current={v.id === activeId}
                    >
                      <span className="block truncate">{v.label}</span>
                      <span className="text-xs text-muted-foreground">
                        <Badge variant="outline" className="mr-1 text-[10px]">{v.kind.toLowerCase()}</Badge>
                        {formatDateTime(v.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">{version.data?.label ?? "Preview"}</CardTitle>
            <div className="flex flex-wrap gap-2">
              {(["pdf", "docx", "txt", "html"] as const).map((f) => (
                <Button key={f} size="sm" variant="outline" onClick={() => exportAs(f)} disabled={!activeId}>
                  Export {f.toUpperCase()}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {!activeId && !versions.isLoading ? <EmptyState title="No resume versions yet" description="Upload and parse a CV during onboarding." /> : null}
            {version.data ? <div className="rounded-md border bg-white p-6 text-black" dangerouslySetInnerHTML={{ __html: version.data.html }} /> : null}
            {versions.data && versions.data.length > 1 ? (
              <div className="space-y-2">
                <label htmlFor="compare" className="text-sm font-medium">
                  Compare with
                </label>
                <NativeSelect id="compare" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} className="max-w-md">
                  <option value="">Select a version</option>
                  {versions.data.filter((v) => v.id !== activeId).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </NativeSelect>
                {diffLines ? (
                  <div className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <p className="font-medium text-emerald-700 dark:text-emerald-300">Added in this version</p>
                      <ul className="mt-1 space-y-1">{diffLines.added.map((l, i) => <li key={i} className="rounded bg-emerald-50 px-2 dark:bg-emerald-950/30">{l}</li>)}</ul>
                    </div>
                    <div>
                      <p className="font-medium text-red-700 dark:text-red-300">Removed</p>
                      <ul className="mt-1 space-y-1">{diffLines.removed.map((l, i) => <li key={i} className="rounded bg-red-50 px-2 dark:bg-red-950/30">{l}</li>)}</ul>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
