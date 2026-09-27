"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { isVerifiedTruthStatus, type AnswerSource, type CandidateAnswerView } from "@applywise/types";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, Skeleton, Textarea, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";

export const CANDIDATE_ANSWERS_KEY = ["candidate-answers"] as const;

const QUESTION_MAX = 500;
const ANSWER_MAX = 2000;

const SOURCE_LABELS: Record<AnswerSource, string> = {
  CANDIDATE_ANSWER: "Written by you",
  PREVIOUS_ANSWER: "From an earlier questionnaire",
  PROFILE: "From your profile",
  PREFERENCE: "From your preferences",
  TRUTH_BANK: "From your verified facts",
  GENERATED: "Drafted",
  UNKNOWN: "Unknown source",
};

/**
 * Question types whose answers are only ever taken from the user (display hint only - the server's answer
 * resolver enforces this). Keys look like "expected_salary" or "skill_experience_years:react".
 */
const SENSITIVE_PREFIXES = new Set(["current_salary", "expected_salary", "notice_period", "work_authorization", "visa_sponsorship", "willing_to_relocate", "earliest_start_date", "diversity"]);
const isSensitive = (questionKey: string) => SENSITIVE_PREFIXES.has(questionKey.split(":")[0] ?? "");

type Upsert = { questionKey?: string; question: string; answer: string };

function validate(question: string, answer: string): string | null {
  if (!question.trim()) return "Enter the question.";
  if (!answer.trim()) return "Enter your answer.";
  if (question.trim().length > QUESTION_MAX) return `Keep the question under ${QUESTION_MAX} characters.`;
  if (answer.trim().length > ANSWER_MAX) return `Keep the answer under ${ANSWER_MAX} characters.`;
  return null;
}

export function AnswersManager({ initialAnswers }: { initialAnswers?: CandidateAnswerView[] }) {
  const qc = useQueryClient();
  const answers = useQuery({ queryKey: CANDIDATE_ANSWERS_KEY, queryFn: () => api<CandidateAnswerView[]>("/api/candidate-answers"), initialData: initialAnswers });
  const [search, setSearch] = useState("");
  const searchId = useId();

  // Toasts are announced to screen readers by the toaster's own live region.
  const announce = (msg: string, kind: "success" | "error" = "success") => {
    if (kind === "success") toast.success(msg);
    else toast.error(msg);
  };

  const all = useMemo(() => answers.data ?? [], [answers.data]);
  const q = search.trim().toLowerCase();
  const visible = q ? all.filter((a) => a.question.toLowerCase().includes(q) || a.answer.toLowerCase().includes(q)) : all;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold leading-none tracking-tight">Your reusable answers</h2>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">These answers are written by you.</span> Whenever an application form asks the same question, ApplyWise reuses your answer -
              nothing here is generated.
            </li>
            <li>
              <ShieldCheck className="mr-1 inline h-4 w-4 align-text-bottom text-emerald-600" aria-hidden="true" />
              Sensitive answers - salary, notice period, work authorisation and visa sponsorship (also relocation and start date) - are only ever taken from here or from your
              profile. ApplyWise never guesses them; if one is missing, the application waits for you.
            </li>
            <li>When you answer a question on an application that needs information, you can choose to remember it here. Edit or delete answers at any time.</li>
            <li>
              Work authorisation and visa answers are tied to a country: write the question with the country (for example &ldquo;Are you authorised to work in India?&rdquo;).
              An answer to a question that names no country is only used for the application it was given for.
            </li>
          </ul>
        </CardContent>
      </Card>

      <AddAnswer existing={all} onDone={announce} />

      <section aria-labelledby={`${searchId}-heading`} className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <h2 id={`${searchId}-heading`} className="text-lg font-semibold">
            Saved answers{answers.data ? <span className="ml-2 text-sm font-normal text-muted-foreground">({all.length})</span> : null}
          </h2>
          {all.length > 5 || search ? (
            <div className="w-full space-y-1.5 sm:w-72">
              <Label htmlFor={searchId}>Search answers</Label>
              <Input id={searchId} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. notice period" />
            </div>
          ) : null}
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {answers.isLoading ? "Loading your answers..." : answers.data ? `${q ? `${visible.length} of ${all.length}` : all.length} saved answers shown.` : ""}
        </p>

        {answers.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : null}

        {answers.error && !answers.data ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load your answers</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{errorMessage(answers.error)}</p>
              <Button size="sm" variant="outline" onClick={() => void answers.refetch()} disabled={answers.isFetching}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {answers.data && all.length === 0 ? (
          <EmptyState title="No saved answers yet" description="Add one above, or answer a question when an application needs information and choose to remember it." />
        ) : null}

        {answers.data && all.length > 0 && visible.length === 0 ? (
          <EmptyState
            title="No answers match your search"
            action={
              <Button size="sm" variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            }
          />
        ) : null}

        {visible.length ? (
          <ul className="space-y-3">
            {visible.map((a) => (
              <li key={a.id}>
                <AnswerRow answer={a} onDone={announce} onRemoved={() => void qc.invalidateQueries({ queryKey: CANDIDATE_ANSWERS_KEY })} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function useUpsert(onSuccess: (saved: CandidateAnswerView) => void, onError: (message: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Upsert) => api<CandidateAnswerView>("/api/candidate-answers", { method: "PUT", body }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: CANDIDATE_ANSWERS_KEY });
      onSuccess(saved);
    },
    onError: (e) => onError(errorMessage(e)),
  });
}

function AddAnswer({ existing, onDone }: { existing: CandidateAnswerView[]; onDone: (msg: string, kind?: "success" | "error") => void }) {
  const ids = useId();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useUpsert(
    (saved) => {
      setQuestion("");
      setAnswer("");
      setError(null);
      // The server files answers by question type, so a similar question replaces the earlier answer.
      const replaced = existing.some((a) => a.id === saved.id);
      onDone(replaced ? "Saved. It replaced your earlier answer to a similar question." : "Answer saved. It will be reused in future applications.");
    },
    (message) => {
      setError(message);
      onDone(message, "error");
    },
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate(question, answer);
    setError(problem);
    if (!problem) save.mutate({ question: question.trim(), answer: answer.trim() });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add an answer</CardTitle>
        <CardDescription>Write the question as employers usually ask it, and the answer you want to give every time.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-q`}>Question</Label>
            <Input
              id={`${ids}-q`}
              value={question}
              maxLength={QUESTION_MAX}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What is your notice period?"
              aria-invalid={error && !question.trim() ? true : undefined}
              aria-describedby={error ? `${ids}-err` : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-a`}>Your answer</Label>
            <Textarea
              id={`${ids}-a`}
              value={answer}
              maxLength={ANSWER_MAX}
              rows={3}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="e.g. 30 days, negotiable"
              aria-invalid={error && !answer.trim() ? true : undefined}
              aria-describedby={error ? `${ids}-err` : undefined}
            />
          </div>
          <div aria-live="polite">
            {error ? (
              <p id={`${ids}-err`} className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
            Save answer
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AnswerRow({ answer, onDone, onRemoved }: { answer: CandidateAnswerView; onDone: (msg: string, kind?: "success" | "error") => void; onRemoved: () => void }) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [question, setQuestion] = useState(answer.question);
  const [text, setText] = useState(answer.answer);
  const [error, setError] = useState<string | null>(null);
  const sensitive = isSensitive(answer.questionKey);
  const inUse = isVerifiedTruthStatus(answer.status);
  // Return keyboard focus to the button that opened the editor / the delete confirmation once it closes.
  const editRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"edit" | "delete" | null>(null);
  useEffect(() => {
    if (editing || confirming || !focusAfter.current) return;
    (focusAfter.current === "edit" ? editRef : deleteRef).current?.focus();
    focusAfter.current = null;
  }, [editing, confirming]);

  const save = useUpsert(
    () => {
      focusAfter.current = "edit";
      setEditing(false);
      setError(null);
      onDone("Answer updated.");
    },
    (message) => {
      setError(message);
      onDone(message, "error");
    },
  );
  const remove = useMutation({
    mutationFn: () => api(`/api/candidate-answers/${encodeURIComponent(answer.id)}`, { method: "DELETE" }),
    onSuccess: () => {
      onRemoved();
      onDone("Answer deleted. Future applications will ask you again if they need it.");
    },
    onError: (e) => {
      focusAfter.current = "delete";
      setConfirming(false);
      onDone(errorMessage(e), "error");
    },
  });

  const startEdit = () => {
    setQuestion(answer.question);
    setText(answer.answer);
    setError(null);
    setConfirming(false);
    setEditing(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate(question, text);
    setError(problem);
    // Same questionKey: the edit replaces this answer instead of creating a new one.
    if (!problem) save.mutate({ questionKey: answer.questionKey, question: question.trim(), answer: text.trim() });
  };

  if (editing) {
    return (
      <Card>
        <CardContent className="pt-5">
          <form onSubmit={submit} className="space-y-4" noValidate aria-label={`Edit answer: ${answer.question}`}>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-q`}>Question</Label>
              <Input
                id={`${ids}-q`}
                value={question}
                maxLength={QUESTION_MAX}
                onChange={(e) => setQuestion(e.target.value)}
                aria-describedby={`${ids}-q-hint${error ? ` ${ids}-err` : ""}`}
                aria-invalid={error && !question.trim() ? true : undefined}
              />
              <p id={`${ids}-q-hint`} className="text-xs text-muted-foreground">
                Rewording keeps this answer linked to the same kind of question.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-a`}>Your answer</Label>
              <Textarea
                id={`${ids}-a`}
                value={text}
                maxLength={ANSWER_MAX}
                rows={3}
                onChange={(e) => setText(e.target.value)}
                autoFocus
                aria-describedby={error ? `${ids}-err` : undefined}
                aria-invalid={error && !text.trim() ? true : undefined}
              />
            </div>
            <div aria-live="polite">
              {error ? (
                <p id={`${ids}-err`} className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                Save changes
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  focusAfter.current = "edit";
                  setEditing(false);
                }}
                disabled={save.isPending}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="candidate-answer">
      <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h3 className="font-medium">{answer.question}</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{answer.answer}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            <Badge variant="outline">{SOURCE_LABELS[answer.source] ?? answer.source}</Badge>
            {sensitive ? (
              <Badge variant="info" title="Only ever taken from you - never guessed">
                Sensitive
              </Badge>
            ) : null}
            {!inUse ? <Badge variant="warning">Not verified - not used until you save it again</Badge> : null}
            <span>
              Updated <time dateTime={answer.updatedAt} title={formatDateTime(answer.updatedAt)}>{timeAgo(answer.updatedAt)}</time>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {confirming ? (
            <>
              <span className="self-center text-sm" id={`${ids}-confirm`}>
                Delete this answer?
              </span>
              <Button size="sm" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending} autoFocus aria-describedby={`${ids}-confirm`}>
                {remove.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  focusAfter.current = "delete";
                  setConfirming(false);
                }}
                disabled={remove.isPending}
              >
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button ref={editRef} size="sm" variant="outline" onClick={startEdit} aria-label={`Edit answer to: ${answer.question}`}>
                <Pencil aria-hidden="true" /> Edit
              </Button>
              <Button
                ref={deleteRef}
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirming(true)}
                aria-label={`Delete answer to: ${answer.question}`}
              >
                <Trash2 aria-hidden="true" /> Delete
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
