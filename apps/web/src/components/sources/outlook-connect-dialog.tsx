"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import type { FeedView, OutlookPollResponse, OutlookStartResponse } from "@/lib/client-types";
import { CopyButton } from "./copy-button";
import { CONSENT_TEXT } from "./feed-utils";
import { useSourceCreated } from "./use-job-feeds";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OutlookConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialEmail?: string;
  onConnected?: (feed: FeedView | undefined) => void;
  /** Reconnecting an existing Outlook source (same address): the server updates it in place. */
  reconnect?: boolean;
}

/** Outlook.com / Hotmail / Microsoft 365: Microsoft device-code sign-in (the user enters a one-time code). */
export function OutlookConnectDialog(props: OutlookConnectDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.reconnect ? "Reconnect Outlook / Hotmail" : "Connect Outlook / Hotmail"}</DialogTitle>
          <DialogDescription>
            {props.reconnect
              ? "Sign in with Microsoft again using a one-time code. Your jobs and settings stay as they are. ApplyWise gets read-only access and never sees your password."
              : "Sign in with Microsoft using a one-time code. ApplyWise gets read-only access and never sees your password."}
          </DialogDescription>
        </DialogHeader>
        <OutlookFlow {...props} />
      </DialogContent>
    </Dialog>
  );
}

type Phase = "form" | "waiting" | "expired" | "denied";

function OutlookFlow({ initialEmail, onOpenChange, onConnected, reconnect }: OutlookConnectDialogProps) {
  const ids = useId();
  const created = useSourceCreated();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [consent, setConsent] = useState(false);
  const [flow, setFlow] = useState<OutlookStartResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const done = useRef<{ onConnected?: OutlookConnectDialogProps["onConnected"]; onOpenChange: OutlookConnectDialogProps["onOpenChange"]; created: typeof created }>({ onConnected, onOpenChange, created });
  useEffect(() => {
    done.current = { onConnected, onOpenChange, created };
  });

  const start = useMutation({
    mutationFn: () => api<OutlookStartResponse>("/api/job-feeds/mailbox/outlook/start", { body: { email: email.trim(), consent: true } }),
    onSuccess: (r) => {
      setError(null);
      setFlow(r);
      setPhase("waiting");
    },
    onError: (e) => {
      const field = e instanceof ApiClientError && e.fieldErrors ? Object.values(e.fieldErrors)[0]?.[0] : null;
      setError({ title: "Could not start the sign-in", message: field ?? errorMessage(e) });
    },
  });

  // Poll every `interval` seconds until the user finishes (or cancels) the Microsoft sign-in.
  useEffect(() => {
    if (!flow || phase !== "waiting") return;
    let cancelled = false;
    let delay = Math.max(2, flow.interval || 5) * 1000;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api<OutlookPollResponse>("/api/job-feeds/mailbox/outlook/poll", { body: { flowToken: flow.flowToken } });
        if (cancelled) return;
        failures = 0;
        if (r.status === "ok") {
          done.current.created(`Outlook ${reconnect ? "reconnected" : "connected"}. Checking your job alerts now - new jobs will appear in your inbox.`);
          done.current.onConnected?.(r.feed);
          done.current.onOpenChange(false);
          return;
        }
        if (r.status === "expired" || r.status === "denied") {
          setPhase(r.status);
          return;
        }
        if (r.status === "slow_down") delay += 5000;
      } catch (e) {
        if (cancelled) return;
        const status = e instanceof ApiClientError ? e.status : 0;
        if (status === 429) {
          delay += 5000;
        } else if (status >= 400 && status < 500) {
          // The server explains what went wrong (missing permission, mailbox limit, ...): polling again
          // would only turn that into "the code expired", because Microsoft has already used the code.
          setError({ title: reconnect ? "Outlook not reconnected" : "Outlook not connected", message: errorMessage(e) });
          setPhase("form");
          setFlow(null);
          return;
        } else if (++failures >= 3) {
          // A network blip should not end the sign-in; give up after a few failures in a row.
          setError({ title: "Could not finish the sign-in", message: errorMessage(e) });
          setPhase("form");
          setFlow(null);
          return;
        }
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, phase, reconnect]);

  const restart = () => {
    setFlow(null);
    setPhase("form");
    start.mutate();
  };

  if (phase === "waiting" && flow) {
    const minutes = Math.max(1, Math.round(flow.expiresIn / 60));
    return (
      <div className="space-y-5">
        <ol className="list-decimal space-y-4 pl-5 text-sm">
          <li className="space-y-2">
            <p>Copy this code:</p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-md border bg-muted px-4 py-2 font-mono text-2xl font-bold tracking-widest" aria-label={`Your code is ${flow.userCode.split("").join(" ")}`} data-testid="outlook-code">
                {flow.userCode}
              </code>
              <CopyButton value={flow.userCode} what="code" />
            </div>
          </li>
          <li className="space-y-2">
            <p>Open the Microsoft sign-in page, paste the code and sign in to {email || "your mailbox"}:</p>
            <a
              href={flow.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Open {flow.verificationUri.replace(/^https?:\/\//, "").replace(/\/$/, "")} <ExternalLink className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
          <li>Come back here. This window updates by itself once you have signed in.</li>
        </ol>
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Waiting for you to sign in... (the code works for about {minutes} min)
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (phase === "expired" || phase === "denied") {
    return (
      <div className="space-y-4">
        <Alert variant={phase === "denied" ? "destructive" : "warning"}>
          <AlertTitle>{phase === "denied" ? "Sign-in was cancelled" : "The code expired"}</AlertTitle>
          <AlertDescription>{phase === "denied" ? "Microsoft reported that access was not allowed. Nothing was connected." : "Codes are valid for a few minutes only. Get a new code and try again."}</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={restart} disabled={start.isPending}>
            {start.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null} Get a new code
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const valid = EMAIL_RE.test(email.trim()) && consent;
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !start.isPending) start.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-email`}>Outlook / Hotmail address</Label>
        <Input id={`${ids}-email`} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@outlook.com" />
      </div>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox checked={consent} onCheckedChange={(c) => setConsent(c === true)} className="mt-0.5" aria-label={CONSENT_TEXT} />
        <span>{CONSENT_TEXT}</span>
      </label>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{error.title}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || start.isPending}>
          {start.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null} Get my sign-in code
        </Button>
      </DialogFooter>
    </form>
  );
}
