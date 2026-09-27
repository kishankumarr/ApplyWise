"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Skeleton, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";

type Consents = { cvProcessing: boolean; aiProcessing: boolean; aiProcessingNeedsRenewal?: boolean; emailSending: boolean; analytics: boolean };
type ConsentKey = "cvProcessing" | "aiProcessing" | "emailSending" | "analytics";

function items(aiLabel: string, aiExternal: boolean): { key: ConsentKey; title: string; body: string }[] {
  return [
  { key: "cvProcessing", title: "CV processing", body: "Store your CV encrypted and extract a structured profile. Required for uploads." },
  {
    key: "aiProcessing",
    title: `AI processing (${aiLabel})`,
    body: aiExternal
      ? "Send relevant CV/job text to this AI provider for parsing and drafting. Off = on-server rules only. Nothing is sent to the provider without this."
      : "Use the AI model running on this server for parsing and drafting. Your data is not sent to a third party. Off = rule-based processing only.",
  },
  { key: "emailSending", title: "Email sending", body: "Allow ApplyWise to send application emails you have reviewed. Every send still needs a final confirmation screen." },
  { key: "analytics", title: "Product analytics", body: "Anonymous usage analytics. Off by default; no analytics provider is configured in this MVP." },
  ];
}

export function PrivacySettings({ aiLabel, aiExternal }: { aiLabel: string; aiExternal: boolean }) {
  const ITEMS = items(aiLabel, aiExternal);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["consents"], queryFn: () => api<Consents>("/api/consents") });
  // Local state gives immediate feedback; the server response is the source of truth.
  const [local, setLocal] = useState<Consents | null>(null);
  useEffect(() => {
    if (data) setLocal(data);
  }, [data]);
  const update = useMutation({
    mutationFn: (patch: Partial<Consents>) => api<Consents>("/api/consents", { method: "PATCH", body: patch }),
    // Optimistic: reflect the toggle immediately, roll back on failure.
    onMutate: (patch) => {
      const previous = qc.getQueryData<Consents>(["consents"]);
      if (previous) qc.setQueryData(["consents"], { ...previous, ...patch });
      void qc.cancelQueries({ queryKey: ["consents"] });
      return { previous };
    },
    onSuccess: (c) => {
      qc.setQueryData(["consents"], c);
      void qc.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Consent updated.");
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(["consents"], ctx.previous);
        setLocal(ctx.previous);
      }
      toast.error(errorMessage(e));
    },
  });
  if (isLoading || !local) return <Skeleton className="h-64" />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Consent</CardTitle>
        <CardDescription>Each change is recorded in your audit log.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {local.aiProcessingNeedsRenewal ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100" data-testid="ai-consent-renewal">
            You allowed AI processing with a model running on this server. This server now uses {aiLabel}, which sends data to a third party, so
            AI is paused for you until you enable it again below.
          </p>
        ) : null}
        {ITEMS.map((i) => (
          <label key={i.key} className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              checked={local[i.key]}
              onCheckedChange={(c) => {
                setLocal({ ...local, [i.key]: c === true });
                update.mutate({ [i.key]: c === true });
              }}
              aria-label={i.title}
            />
            <span className="text-sm">
              <span className="font-medium">{i.title}</span>
              <span className="block text-muted-foreground">{i.body}</span>
            </span>
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
