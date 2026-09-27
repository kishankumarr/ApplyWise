"use client";

import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, toast } from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import type { FeedView, MailboxOptions } from "@/lib/client-types";
import { APP_PASSWORD_NOTE, presetNotes } from "./feed-utils";
import { checkAndReport, FEEDS_KEY } from "./use-job-feeds";

interface Props {
  feed: FeedView;
  mailbox: MailboxOptions | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Reconnect an app-password mailbox whose password stopped working (changed or revoked). The form
 * lives inside the dialog content, which unmounts on close, so the password is discarded then.
 */
export function ImapReconnectDialog(props: Props) {
  const [busy, setBusy] = useState(false);
  const email = typeof props.feed.config.email === "string" ? props.feed.config.email : props.feed.label;
  return (
    <Dialog open={props.open} onOpenChange={(o) => (busy && !o ? undefined : props.onOpenChange(o))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reconnect {email}</DialogTitle>
          <DialogDescription>The saved app password no longer works - it was probably changed or revoked. Create a new one and paste it here. Your jobs and settings stay as they are.</DialogDescription>
        </DialogHeader>
        <ReconnectForm {...props} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function ReconnectForm({ feed, mailbox, onOpenChange, onBusyChange }: Props & { onBusyChange: (b: boolean) => void }) {
  const ids = useId();
  const qc = useQueryClient();
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const presetId = typeof feed.config.preset === "string" ? feed.config.preset : null;
  const preset = presetId ? (mailbox?.imapPresets ?? []).find((p) => p.id === presetId) ?? null : null;
  const notes = presetNotes(preset);
  const custom = !presetId || presetId === "custom";

  const reconnect = useMutation({
    // Providers show app passwords in groups ("abcd efgh ijkl mnop"); the spaces are not part of it.
    mutationFn: () => api<FeedView>(`/api/job-feeds/${feed.id}/reconnect`, { body: { appPassword: custom ? appPassword : appPassword.replace(/\s+/g, "") } }),
    onSuccess: (updated) => {
      setAppPassword("");
      void qc.invalidateQueries({ queryKey: FEEDS_KEY });
      onOpenChange(false);
      toast.success("Mailbox reconnected. Checking your job alerts now.", { description: "ApplyWise tells you when it is done." });
      void checkAndReport(qc, updated);
    },
    onError: (e) => {
      const field = e instanceof ApiClientError && e.fieldErrors ? Object.values(e.fieldErrors)[0]?.[0] : null;
      setError(field ?? errorMessage(e));
    },
  });

  useEffect(() => onBusyChange(reconnect.isPending), [reconnect.isPending, onBusyChange]);
  const canSubmit = appPassword.trim().length >= 4 && !reconnect.isPending;

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (canSubmit) reconnect.mutate();
      }}
    >
      <ol className="space-y-4">
        <li className="space-y-2">
          <p className="text-sm font-medium">
            <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground" aria-hidden="true">
              1
            </span>
            {preset ? `Create a new app password in your ${preset.label} account` : "Get a new app password (or IMAP password) from your email provider"}
          </p>
          <div className="space-y-2 pl-8 text-sm text-muted-foreground">
            {preset?.appPasswordUrl ? (
              <a
                href={preset.appPasswordUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" /> Open {preset.label} app passwords
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
            {notes.length ? (
              <ul className="list-disc space-y-1 pl-5">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
            <p>{APP_PASSWORD_NOTE}</p>
          </div>
        </li>
        <li className="space-y-2">
          <p className="text-sm font-medium">
            <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground" aria-hidden="true">
              2
            </span>
            <label htmlFor={`${ids}-pw`}>Paste the new app password</label>
          </p>
          <div className="space-y-1 pl-8">
            <Input
              id={`${ids}-pw`}
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
              placeholder="xxxx xxxx xxxx xxxx"
              aria-describedby={`${ids}-pw-hint`}
            />
            <p id={`${ids}-pw-hint`} className="text-xs text-muted-foreground">
              Not your normal email password. ApplyWise tests it first, then stores it encrypted and never shows it again.
            </p>
          </div>
        </li>
      </ol>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not reconnect</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={reconnect.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {reconnect.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" /> Checking your mailbox...
            </>
          ) : (
            "Reconnect"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
