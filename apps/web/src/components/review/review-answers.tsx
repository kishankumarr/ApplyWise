"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Checkbox, Input, Label, NativeSelect, Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, toast } from "@applywise/ui";
import type { PendingQuestion, ReviewQueueItem } from "@applywise/types";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView } from "@/lib/client-types";
import { plural } from "@/lib/format";
import { ANSWER_SOURCE_LABELS, ANSWER_SOURCE_VARIANTS, effectiveMode, invalidateRelated, removeFromQueue, type ReviewContext } from "./review-shared";

function RequiredMarker() {
  return (
    <>
      <span aria-hidden="true" className="text-destructive">
        {" "}
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

/** The screening questions and the answers the automation prepared, with where each answer came from. */
export function AnswersTable({ answers, headingId }: { answers: ReviewQueueItem["answers"]; headingId: string }) {
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-semibold">
        Questions &amp; answers
      </h3>
      {answers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No screening questions for this job.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-2/5">Question</TableHead>
                <TableHead>Answer</TableHead>
                <TableHead className="w-40">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {answers.map((a) => {
                const hasAnswer = a.resolved && a.answer.trim().length > 0;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="align-top font-medium">
                      {a.question}
                      {a.required ? <RequiredMarker /> : null}
                    </TableCell>
                    <TableCell className="max-w-md whitespace-pre-wrap break-words align-top">
                      {hasAnswer ? (
                        a.answer
                      ) : a.answer.trim() ? (
                        <>
                          {a.answer}
                          <span className="block text-xs text-amber-700 dark:text-amber-300">Not verified - left out of the application.</span>
                        </>
                      ) : (
                        <span className="italic text-muted-foreground">No verified answer yet - left out of the application.</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant={ANSWER_SOURCE_VARIANTS[a.source]}>{ANSWER_SOURCE_LABELS[a.source]}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {answers.some((a) => a.required) ? (
            <p className="text-xs text-muted-foreground">
              <span aria-hidden="true" className="text-destructive">
                *
              </span>{" "}
              Required by the employer.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

type AnswerInput = { key: string; question: string; answer: string; remember: boolean };

/**
 * NEEDS_INFORMATION: the questions without a verified answer. The automation never guesses - the user answers
 * them here, the answers are stored as the user's own and preparation resumes.
 */
export function PendingQuestionsForm({ item, ctx, headingId }: { item: ReviewQueueItem; ctx: ReviewContext; headingId: string }) {
  const qc = useQueryClient();
  const id = item.applicationId;
  const questions = item.pendingQuestions;
  const [values, setValues] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const mode = effectiveMode(item, ctx.settingsMode);
  const fieldId = (i: number) => `${id}-pending-${i}`;

  const save = useMutation({
    mutationFn: (answers: AnswerInput[]) => api<ApplicationView>(`/api/applications/${id}/answers`, { body: { answers } }),
    onSuccess: (app, answers) => {
      qc.setQueryData(["application", id], app);
      const resumed = app.status !== "NEEDS_INFORMATION";
      if (resumed) {
        ctx.onLeave(id);
        removeFromQueue(qc, id);
        ctx.watch();
      }
      void invalidateRelated(qc);
      const saved = `Saved ${plural(answers.length, "answer")}.`;
      if (!resumed) toast.success(`${saved} Some questions still need an answer.`);
      else if (mode === "AUTO")
        toast.success(`${saved} Preparation resumes with your answers. If every rule and safety check passes, Auto mode may submit it; otherwise it comes back here.`);
      else toast.success(`${saved} Preparation resumes with your answers - the application comes back here when it is ready.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const nextErrors: Record<string, string> = {};
    questions.forEach((q) => {
      if (q.required && !values[q.key]?.trim()) nextErrors[q.key] = "Please answer this required question.";
    });
    setErrors(nextErrors);
    const firstInvalid = questions.findIndex((q) => nextErrors[q.key]);
    if (firstInvalid >= 0) {
      setFormError(null);
      document.getElementById(fieldId(firstInvalid))?.focus();
      return;
    }
    const answers = questions
      .filter((q) => values[q.key]?.trim())
      .map((q) => ({ key: q.key, question: q.question, answer: values[q.key]!.trim(), remember: remember[q.key] ?? true }));
    if (answers.length === 0) {
      setFormError("Answer at least one question.");
      document.getElementById(fieldId(0))?.focus();
      return;
    }
    setFormError(null);
    save.mutate(answers);
  };

  const setValue = (q: PendingQuestion, v: string) => {
    setValues((s) => ({ ...s, [q.key]: v }));
    if (errors[q.key] && v.trim()) setErrors((s) => ({ ...s, [q.key]: "" }));
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-950/20">
      <div>
        <h3 id={headingId} className="text-sm font-semibold">
          Answer to continue
        </h3>
        <p className="text-sm text-muted-foreground">
          These questions have no verified answer, and the automation never guesses. Your answers are used only as you write them.
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {questions.map((q, i) => {
          const fid = fieldId(i);
          const err = errors[q.key];
          const describedBy = [q.sensitive ? `${fid}-hint` : null, err ? `${fid}-error` : null].filter(Boolean).join(" ") || undefined;
          const common = {
            id: fid,
            value: values[q.key] ?? "",
            "aria-invalid": err ? true : undefined,
            "aria-describedby": describedBy,
            "aria-required": q.required || undefined,
            disabled: save.isPending,
          };
          return (
            <div key={q.key} className="space-y-1.5">
              <Label htmlFor={fid}>
                {q.question}
                {q.required ? <RequiredMarker /> : null}
              </Label>
              {q.options?.length ? (
                <NativeSelect {...common} onChange={(e) => setValue(q, e.target.value)}>
                  <option value="">Choose an answer…</option>
                  {q.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </NativeSelect>
              ) : q.canonicalKey === "custom" ? (
                <Textarea {...common} rows={3} maxLength={2000} onChange={(e) => setValue(q, e.target.value)} />
              ) : (
                <Input {...common} maxLength={2000} onChange={(e) => setValue(q, e.target.value)} />
              )}
              {q.sensitive ? (
                <p id={`${fid}-hint`} className="text-xs text-muted-foreground">
                  Only an answer you give is ever used for this question - it is never inferred.
                </p>
              ) : null}
              {err ? (
                <p id={`${fid}-error`} className="text-xs text-destructive">
                  {err}
                </p>
              ) : null}
              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id={`${fid}-remember`}
                  checked={remember[q.key] ?? true}
                  onCheckedChange={(c) => setRemember((s) => ({ ...s, [q.key]: c === true }))}
                  disabled={save.isPending}
                />
                <Label htmlFor={`${fid}-remember`} className="text-xs font-normal">
                  Save for future applications
                </Label>
              </div>
            </div>
          );
        })}
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            Save answers &amp; continue
          </Button>
          {save.isPending ? <Spinner label="Saving your answers" /> : null}
        </div>
      </form>
    </section>
  );
}
