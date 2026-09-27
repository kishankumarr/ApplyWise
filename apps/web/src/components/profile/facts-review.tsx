"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
import type { TruthStatus } from "@applywise/types";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { ProfileView } from "@/lib/client-types";

const STATUS_BADGE: Record<TruthStatus, { label: string; variant: "success" | "warning" | "secondary" | "info" }> = {
  PARSED_UNVERIFIED: { label: "Unverified", variant: "warning" },
  USER_VERIFIED: { label: "Verified", variant: "success" },
  USER_EDITED: { label: "Edited", variant: "info" },
  USER_REJECTED: { label: "Rejected", variant: "secondary" },
};

function FactRow({ id, text, status, editable = true }: { id: string; text: string; status: TruthStatus; editable?: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const refresh = () => qc.invalidateQueries({ queryKey: ["profile"] });
  const verify = useMutation({
    mutationFn: (editedText?: string) => api(`/api/profile/facts/${id}/verify`, { body: editedText ? { editedText } : {} }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reject = useMutation({
    mutationFn: () => api(`/api/profile/facts/${id}/reject`, { body: {} }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const badge = STATUS_BADGE[status];
  return (
    <li className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between" data-testid="fact-row" data-status={status}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Edit fact" />
        ) : (
          <p className={status === "USER_REJECTED" ? "text-sm text-muted-foreground line-through" : "text-sm"}>{text}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {editing ? (
          <>
            <Button size="sm" onClick={() => verify.mutate(value)} disabled={verify.isPending || !value.trim()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="icon" variant="ghost" aria-label={`Confirm: ${text.slice(0, 40)}`} title="Confirm this is true" onClick={() => verify.mutate(undefined)} disabled={verify.isPending || status === "USER_VERIFIED"}>
              <Check />
            </Button>
            {editable ? (
              <Button size="icon" variant="ghost" aria-label={`Edit: ${text.slice(0, 40)}`} title="Edit" onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
            ) : null}
            <Button size="icon" variant="ghost" aria-label={`Reject: ${text.slice(0, 40)}`} title="This is not accurate" onClick={() => reject.mutate()} disabled={reject.isPending || status === "USER_REJECTED"}>
              <X />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function FactsReview({ view }: { view: ProfileView }) {
  const qc = useQueryClient();
  const p = view.profile;
  const verifyAll = useMutation({
    mutationFn: () => api<{ verified: number }>("/api/profile/facts/verify-all", { body: {} }),
    onSuccess: (r) => {
      toast.success(`${r.verified} facts confirmed.`);
      void qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [newSkill, setNewSkill] = useState("");
  const addSkill = useMutation({
    mutationFn: (name: string) => api("/api/profile/skills", { body: { name } }),
    onSuccess: () => {
      setNewSkill("");
      void qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const loose = p.truthBankItems.filter((f) => !f.experienceId && !f.projectId && !f.educationId && f.kind !== "QUESTIONNAIRE_ANSWER");
  const answers = p.truthBankItems.filter((f) => f.kind === "QUESTIONNAIRE_ANSWER");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
        <p className="text-sm">
          <strong>{view.verification.unverified}</strong> unverified · <strong>{view.verification.verified}</strong> verified · {view.verification.rejected} rejected.
          <span className="block text-muted-foreground">Only facts you confirm are used for matching evidence and generated content.</span>
        </p>
        <Button variant="outline" onClick={() => verifyAll.mutate()} disabled={verifyAll.isPending || view.verification.unverified === 0}>
          Confirm all remaining as accurate
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Experience</CardTitle>
          <CardDescription>Confirm each role and bullet. Rejecting a role removes its bullets from evidence.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {p.experience.length === 0 ? <p className="text-sm text-muted-foreground">No experience parsed.</p> : null}
          {p.experience.map((e) => (
            <div key={e.id} className="rounded-md border p-3">
              <ul>
                <FactRow id={e.id} text={`${e.title} · ${e.company}${e.startDate ? ` · ${e.startDate} – ${e.isCurrent ? "Present" : e.endDate ?? ""}` : ""}`} status={e.status} editable={false} />
              </ul>
              <ul className="ml-3 divide-y border-l pl-3">
                {e.bullets.map((b) => (
                  <FactRow key={b.id} id={b.id} text={b.text} status={b.status} />
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Skills</CardTitle>
          <CardDescription>Skills listed only here are weaker evidence than skills shown in experience or projects.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {p.skills.map((s) => (
              <FactRow key={s.id} id={s.id} text={`${s.name}${s.source !== "SKILLS_SECTION" ? ` (${s.source.toLowerCase().replace("_", " ")})` : ""}`} status={s.status} />
            ))}
          </ul>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newSkill.trim()) addSkill.mutate(newSkill.trim());
            }}
          >
            <Input value={newSkill} onChange={(e) => setNewSkill(e.target.value)} placeholder="Add a skill you genuinely have" aria-label="New skill" />
            <Button type="submit" variant="outline" disabled={addSkill.isPending}>
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projects & education</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {p.projects.map((pr) => (
              <FactRow key={pr.id} id={pr.id} text={`${pr.name}${pr.description ? ` - ${pr.description}` : ""}`} status={pr.status} editable={false} />
            ))}
            {p.education.map((ed) => (
              <FactRow key={ed.id} id={ed.id} text={[ed.degree, ed.field, ed.institution, ed.endYear].filter(Boolean).join(", ")} status={ed.status} editable={false} />
            ))}
          </ul>
        </CardContent>
      </Card>

      {loose.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary, certifications & achievements</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {loose.map((f) => (
                <FactRow key={f.id} id={f.id} text={f.text} status={f.status} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {answers.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Facts from your questionnaire answers</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {answers.map((f) => (
                <FactRow key={f.id} id={f.id} text={f.text} status={f.status} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
