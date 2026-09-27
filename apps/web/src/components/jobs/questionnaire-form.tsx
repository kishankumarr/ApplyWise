"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2 } from "lucide-react";
import type { JobQuestion } from "@applywise/types";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Textarea, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { QuestionnaireView } from "@/lib/client-types";

type Answers = Record<string, { value: string; freeText: string | null }>;

function visible(q: JobQuestion, answers: Answers): boolean {
  if (!q.showWhen) return true;
  const a = answers[q.showWhen.questionId];
  return !!a && q.showWhen.equalsAny.includes(a.value);
}

export function QuestionnaireForm({ jobId, onCompleted }: { jobId: string; onCompleted?: () => void }) {
  const qc = useQueryClient();
  const key = ["questionnaire", jobId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api<QuestionnaireView | null>(`/api/jobs/${jobId}/questionnaire`) });
  const [answers, setAnswers] = useState<Answers>({});
  useEffect(() => {
    if (data) setAnswers(data.answers);
  }, [data]);

  const generate = useMutation({
    mutationFn: (regenerate: boolean) => api<QuestionnaireView>(`/api/jobs/${jobId}/questionnaire${regenerate ? "?regenerate=true" : ""}`, { body: {} }),
    onSuccess: (q) => qc.setQueryData(key, q),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (complete: boolean) => {
      const visibleAnswers = Object.fromEntries(
        Object.entries(answers).filter(([k, v]) => {
          const q = data?.questions.find((x) => x.id === k);
          return q && visible(q, answers) && (v.value || v.freeText);
        }),
      );
      return api<QuestionnaireView>(`/api/jobs/${jobId}/questionnaire/answers`, { body: { answers: visibleAnswers, complete } });
    },
    onSuccess: (q, complete) => {
      qc.setQueryData(key, q);
      void qc.invalidateQueries({ queryKey: ["profile"] });
      toast.success(complete ? "Answers saved. Truthful answers were added to your verified facts." : "Progress saved.");
      if (complete) onCompleted?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading) return null;
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job-specific questions</CardTitle>
          <CardDescription>3-8 short questions based on the gap between this job and your verified profile. Answering “No” is always fine.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => generate.mutate(false)} disabled={generate.isPending}>
            {generate.isPending ? <Loader2 className="animate-spin" /> : null} Generate questions
          </Button>
          {generate.isPending ? (
            <p className="mt-2 text-xs text-muted-foreground" role="status">
              Generating questions… this can take a minute or two when a local AI model is used.
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const setA = (id: string, patch: Partial<{ value: string; freeText: string | null }>) =>
    setAnswers((a) => ({ ...a, [id]: { value: a[id]?.value ?? "", freeText: a[id]?.freeText ?? null, ...patch } }));

  return (
    <Card data-testid="questionnaire">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Job-specific questions</CardTitle>
          <Badge variant={data.status === "COMPLETED" ? "success" : "outline"}>{data.status.replace("_", " ").toLowerCase()}</Badge>
        </div>
        <CardDescription>
          Never claim a skill you do not have. Answers you give become verified facts only when they are positive and truthful.
          {data.provider === "fallback" ? " (Rule-based questions)" : ` (Generated with ${data.modelId ?? data.provider})`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {data.questions.filter((q) => visible(q, answers)).map((q) => (
          <fieldset key={q.id} className="space-y-2" data-testid={`question-${q.id}`}>
            <legend className="text-sm font-medium">
              {q.text} {q.requiredForJob ? <span className="text-xs text-muted-foreground">(important for this job)</span> : null}
            </legend>
            <p className="flex items-start gap-1 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> {q.whyAsked}
            </p>
            {q.options ? (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={q.text}>
                {q.options.map((o) => {
                  const checked = answers[q.id]?.value === o.value;
                  return (
                    <label key={o.value} className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${checked ? "border-primary bg-primary/10" : ""}`}>
                      <input type="radio" className="sr-only" name={q.id} value={o.value} checked={checked} onChange={() => setA(q.id, { value: o.value })} />
                      {o.label}
                    </label>
                  );
                })}
              </div>
            ) : null}
            {q.allowFreeText ? (
              <div>
                <Label htmlFor={`fq-${q.id}`} className="sr-only">
                  Answer
                </Label>
                <Textarea
                  id={`fq-${q.id}`}
                  rows={2}
                  value={answers[q.id]?.freeText ?? ""}
                  onChange={(e) => setA(q.id, { freeText: e.target.value, value: answers[q.id]?.value || "text" })}
                  placeholder="Your answer (leave blank to skip)"
                />
              </div>
            ) : null}
          </fieldset>
        ))}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={() => generate.mutate(true)} disabled={generate.isPending || save.isPending}>
            {generate.isPending ? <Loader2 className="animate-spin" /> : null} Regenerate questions
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending || generate.isPending}>
              Save progress
            </Button>
            <Button onClick={() => save.mutate(true)} disabled={save.isPending || generate.isPending}>
              Save answers
            </Button>
          </div>
        </div>
        {generate.isPending ? (
          <p className="text-xs text-muted-foreground" role="status">
            Regenerating questions… this can take a minute or two when a local AI model is used. Saving is paused until the new questions arrive.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
