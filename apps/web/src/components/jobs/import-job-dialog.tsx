"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  NativeSelect,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";

type ImportResult = { imported: { jobId: string; duplicate: boolean; merged?: boolean; upgraded?: boolean; title: string; company: string }[] };

/** "Imported 2 jobs, updated the existing job with the full description, 1 duplicate skipped." */
function importSummary(r: ImportResult): string {
  const created = r.imported.filter((x) => !x.duplicate).length;
  const upgraded = r.imported.filter((x) => x.duplicate && x.upgraded).length;
  const merged = r.imported.filter((x) => x.duplicate && x.merged && !x.upgraded).length;
  const skipped = r.imported.filter((x) => x.duplicate && !x.merged && !x.upgraded).length;
  const parts: string[] = [];
  if (created) parts.push(`Imported ${created} job${created === 1 ? "" : "s"}`);
  if (upgraded) parts.push(upgraded === 1 ? "Updated the existing job with the full description" : `Updated ${upgraded} existing jobs with the full description`);
  if (merged) parts.push(merged === 1 ? "Added this source to a job you already had" : `Added these sources to ${merged} jobs you already had`);
  if (skipped) parts.push(`${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`);
  if (!parts.length) return "Nothing to import.";
  const text = parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(", ");
  return `${text}.`;
}

export function ImportJobDialog() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState({ title: "", company: "", location: "", workMode: "", description: "", requiredSkills: "", preferredSkills: "", applyUrl: "", hrEmail: "" });
  const [paste, setPaste] = useState({ description: "", applyUrl: "" });
  const [career, setCareer] = useState({ sourceUrl: "", title: "", company: "", description: "" });
  const [csv, setCsv] = useState("");
  const [email, setEmail] = useState("");

  const done = (r: ImportResult) => {
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    // An existing job may have been upgraded with the full description: refresh its detail view too.
    void qc.invalidateQueries({ queryKey: ["job"] });
    const first = r.imported[0];
    toast.success(importSummary(r));
    setOpen(false);
    if (r.imported.length === 1 && first) router.push(`/jobs/${first.jobId}`);
  };
  const fail = (e: unknown) => {
    const fe = e instanceof ApiClientError && e.fieldErrors ? Object.entries(e.fieldErrors).map(([k, v]) => `${k}: ${v[0]}`).join("; ") : "";
    setError(fe || errorMessage(e));
  };

  const m = useMutation({ mutationFn: (body: unknown) => api<ImportResult>("/api/jobs/manual", { body }), onSuccess: done, onError: fail });
  const c = useMutation({ mutationFn: (text: string) => api<ImportResult>("/api/jobs/import/csv", { body: { csv: text } }), onSuccess: done, onError: fail });
  const em = useMutation({ mutationFn: (raw: string) => api<ImportResult>("/api/jobs/import/email", { body: { raw } }), onSuccess: done, onError: fail });
  const busy = m.isPending || c.isPending || em.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus /> Import job
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a job</DialogTitle>
          <DialogDescription>Only compliant sources: your own entry, pasted text, official career-page URLs (not fetched), CSV or job-alert emails you received.</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Tabs defaultValue="paste">
          <TabsList>
            <TabsTrigger value="paste">Paste description</TabsTrigger>
            <TabsTrigger value="manual">Manual entry</TabsTrigger>
            <TabsTrigger value="career">Career page URL</TabsTrigger>
            <TabsTrigger value="email">Job-alert email</TabsTrigger>
            <TabsTrigger value="csv">CSV</TabsTrigger>
          </TabsList>

          <TabsContent value="paste" className="space-y-3">
            <Label htmlFor="paste-desc">Job description</Label>
            <Textarea id="paste-desc" rows={10} value={paste.description} onChange={(e) => setPaste({ ...paste, description: e.target.value })} placeholder="Paste the full job description, including requirements and how to apply." />
            <Label htmlFor="paste-url">Official apply URL (optional)</Label>
            <Input id="paste-url" value={paste.applyUrl} onChange={(e) => setPaste({ ...paste, applyUrl: e.target.value })} />
            <Button disabled={busy} onClick={() => m.mutate({ mode: "paste", description: paste.description, applyUrl: paste.applyUrl })}>
              Import
            </Button>
          </TabsContent>

          <TabsContent value="manual" className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["title", "Job title"],
                ["company", "Company"],
                ["location", "Locations (comma separated)"],
                ["requiredSkills", "Required skills (comma separated)"],
                ["preferredSkills", "Preferred skills (comma separated)"],
                ["applyUrl", "Official apply URL"],
                ["hrEmail", "HR email"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`m-${k}`}>{label}</Label>
                <Input id={`m-${k}`} value={manual[k]} onChange={(e) => setManual({ ...manual, [k]: e.target.value })} />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="m-mode">Work mode</Label>
              <NativeSelect id="m-mode" value={manual.workMode} onChange={(e) => setManual({ ...manual, workMode: e.target.value })}>
                <option value="">Not stated</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">Onsite</option>
              </NativeSelect>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="m-desc">Description</Label>
              <Textarea id="m-desc" rows={6} value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
            </div>
            <Button
              className="sm:col-span-2"
              disabled={busy}
              onClick={() =>
                m.mutate({
                  mode: "structured",
                  ...manual,
                  workMode: manual.workMode || undefined,
                  location: manual.location,
                })
              }
            >
              Save job
            </Button>
          </TabsContent>

          <TabsContent value="career" className="space-y-3">
            <p className="text-sm text-muted-foreground">We save the official URL and the description you paste. The page itself is never fetched or scraped.</p>
            <Label htmlFor="c-url">Official career-page URL</Label>
            <Input id="c-url" value={career.sourceUrl} onChange={(e) => setCareer({ ...career, sourceUrl: e.target.value })} placeholder="https://boards.greenhouse.io/company/jobs/123" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="c-title">Job title</Label>
                <Input id="c-title" value={career.title} onChange={(e) => setCareer({ ...career, title: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-company">Company</Label>
                <Input id="c-company" value={career.company} onChange={(e) => setCareer({ ...career, company: e.target.value })} />
              </div>
            </div>
            <Label htmlFor="c-desc">Description (paste from the page)</Label>
            <Textarea id="c-desc" rows={8} value={career.description} onChange={(e) => setCareer({ ...career, description: e.target.value })} />
            <Button disabled={busy} onClick={() => m.mutate({ mode: "career_page_url", ...career })}>
              Save career-page job
            </Button>
          </TabsContent>

          <TabsContent value="email" className="space-y-3">
            <p className="text-sm text-muted-foreground">Paste the raw email (or .eml source) of a job alert you received. Only job details are kept - never your inbox.</p>
            <Textarea aria-label="Job-alert email" rows={10} value={email} onChange={(e) => setEmail(e.target.value)} />
            <input
              type="file"
              accept=".eml,.txt,message/rfc822,text/plain"
              aria-label="Upload .eml file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setEmail(await f.text());
              }}
            />
            <Button disabled={busy || email.length < 20} onClick={() => em.mutate(email)}>
              Import from email
            </Button>
          </TabsContent>

          <TabsContent value="csv" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Columns: title, company, location, work_mode, description, required_skills, preferred_skills, experience_min, experience_max, apply_url, hr_email, platform, source_url, posted_at.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Upload CSV"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
              }}
            />
            <Textarea aria-label="CSV content" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} />
            <Button disabled={busy || csv.length < 10} onClick={() => c.mutate(csv)}>
              Import CSV
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
