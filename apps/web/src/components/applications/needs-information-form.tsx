"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { HelpCircle } from "lucide-react";
import type { ApplicationMode, PendingQuestion } from "@applywise/types";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, NativeSelect, Spinner, Textarea, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView } from "@/lib/client-types";

/** Questions a plain yes/no answer fits when the employer gave no options. */
const YES_NO_KEYS = new Set(["visa_sponsorship", "willing_to_relocate"]);
/** Free-text questions that deserve more room. */
const LONG_KEYS = new Set(["custom", "skill_experience", "cover_letter"]);
const MAX_ANSWER = 2000;
/**
 * Work authorisation / sponsorship answers hold for one country only: the server saves them for the job's country, or
 * for this application only when the question names no country and the job's country is unknown.
 */
const COUNTRY_BOUND_KEYS = new Set(["work_authorization", "visa_sponsorship"]);
const countryBound = (q: PendingQuestion) => COUNTRY_BOUND_KEYS.has(q.canonicalKey) && !q.key.includes(":");

function inputTypeFor(q: PendingQuestion): "select" | "textarea" | "email" | "url" | "tel" | "number" | "text" {
  if (q.options?.length || YES_NO_KEYS.has(q.canonicalKey)) return "select";
  if (LONG_KEYS.has(q.canonicalKey)) return "textarea";
  if (q.canonicalKey === "email") return "email";
  if (q.canonicalKey.endsWith("_url")) return "url";
  if (q.canonicalKey === "phone") return "tel";
  if (q.canonicalKey.endsWith("_years")) return "number";
  return "text";
}

function resumeText(mode: ApplicationMode | null): string {
  if (mode === "AUTO") return "After you save, the application is prepared again with your answers and continues automatically. It is submitted only if every Auto rule and safety check still passes - otherwise it waits for you.";
  if (mode === "REVIEW") return "After you save, the application is prepared again with your answers and then waits for your approval. Nothing is submitted without it.";
  return "After you save, the drafts are prepared again with your answers for your review. Nothing is submitted for you.";
}

/** NEEDS_INFORMATION: the automation found required questions without a verified answer. */
export function NeedsInformationForm({ app, onSaved }: { app: ApplicationView; onSaved: (a: ApplicationView) => void }) {
  const questions = app.automation.pendingQuestions;
  const [values, setValues] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (answers: { key: string; question: string; answer: string; remember: boolean }[]) =>
      api<ApplicationView>(`/api/applications/${app.id}/answers`, { body: { answers } }),
    onSuccess: (a) => {
      setValues({});
      setErrors({});
      onSaved(a);
      toast.success("Answers saved. The application continues with them.");
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const nextErrors: Record<string, string> = {};
    const answers: { key: string; question: string; answer: string; remember: boolean }[] = [];
    for (const q of questions) {
      const value = (values[q.key] ?? "").trim();
      if (!value) {
        if (q.required) nextErrors[q.key] = "This question is required.";
        continue;
      }
      if (value.length > MAX_ANSWER) {
        nextErrors[q.key] = `Keep the answer under ${MAX_ANSWER} characters.`;
        continue;
      }
      answers.push({ key: q.key, question: q.question.slice(0, 500), answer: value, remember: remember[q.key] ?? true });
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFormError("Please answer the required questions.");
      return;
    }
    if (!answers.length) {
      setFormError("Answer at least one question.");
      return;
    }
    setFormError(null);
    save.mutate(answers);
  };

  return (
    <Card className="border-amber-300 dark:border-amber-800" data-testid="needs-information">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="h-4 w-4" aria-hidden="true" /> A few answers are needed
        </CardTitle>
        <CardDescription>
          The employer asks {questions.length === 1 ? "a question" : "questions"} your verified profile cannot answer. ApplyWise never guesses these. {resumeText(app.automation.mode)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={onSubmit} noValidate aria-describedby={formError ? "ni-form-error" : undefined}>
          {questions.map((q, i) => {
            const id = `ni-${i}`;
            const type = inputTypeFor(q);
            const error = errors[q.key];
            const describedBy = [q.sensitive ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
            const common = {
              id,
              value: values[q.key] ?? "",
              "aria-invalid": error ? true : undefined,
              "aria-describedby": describedBy,
              "aria-required": q.required || undefined,
            };
            const set = (v: string) => setValues((s) => ({ ...s, [q.key]: v }));
            return (
              <div key={q.key} className="space-y-1.5">
                <Label htmlFor={id}>
                  {q.question}
                  {q.required ? <span className="ml-1 text-xs font-normal text-muted-foreground">(required)</span> : <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>}
                </Label>
                {type === "select" ? (
                  <NativeSelect {...common} onChange={(e) => set(e.target.value)}>
                    <option value="">Choose…</option>
                    {(q.options?.length ? q.options : ["Yes", "No"]).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </NativeSelect>
                ) : type === "textarea" ? (
                  <Textarea {...common} rows={3} maxLength={MAX_ANSWER} onChange={(e) => set(e.target.value)} />
                ) : (
                  <Input
                    {...common}
                    type={type === "number" ? "text" : type}
                    inputMode={type === "number" ? "decimal" : undefined}
                    autoComplete={type === "email" ? "email" : type === "tel" ? "tel" : type === "url" ? "url" : "off"}
                    maxLength={MAX_ANSWER}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
                {q.sensitive ? (
                  <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                    Personal detail - only your own answer is ever used for this.
                  </p>
                ) : null}
                {error ? (
                  <p id={`${id}-error`} className="text-xs text-destructive">
                    {error}
                  </p>
                ) : null}
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={remember[q.key] ?? true}
                    onCheckedChange={(c) => setRemember((s) => ({ ...s, [q.key]: c === true }))}
                    aria-label={`Save for future applications: ${q.question}`}
                  />
                  Save for future applications
                </label>
                {countryBound(q) ? (
                  <p className="text-xs text-muted-foreground">
                    Saved for jobs in this job&apos;s country only. If the job&apos;s country is not clear, the answer is used for this application only - it may differ for other countries.
                  </p>
                ) : null}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Spinner label="Saving answers" /> : null}
              Save answers and continue
            </Button>
            <p id="ni-form-error" className="text-sm text-destructive" aria-live="polite">
              {formError ?? ""}
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
