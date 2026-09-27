"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Loader2, ShieldCheck } from "lucide-react";
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
  NativeSelect,
} from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import type { FeedView, MailboxOptions } from "@/lib/client-types";
import { APP_PASSWORD_NOTE, CONSENT_TEXT, guessPreset, isMicrosoftPreset, presetNotes } from "./feed-utils";
import { useSourceCreated } from "./use-job-feeds";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ImapConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mailbox: MailboxOptions;
  initialEmail?: string;
  onConnected?: (feed: FeedView) => void;
  /** Outlook/Hotmail addresses need the Microsoft sign-in; the parent opens that dialog. */
  onUseOutlook?: (email: string) => void;
  onUseForwarding?: () => void;
}

/**
 * "Connect email with an app password". The form lives inside the dialog content, which unmounts
 * on close, so the app password is discarded whenever the dialog closes.
 */
export function ImapConnectDialog(props: ImapConnectDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={(o) => (busy && !o ? undefined : props.onOpenChange(o))}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect email with an app password</DialogTitle>
          <DialogDescription>Use the mailbox where your Naukri, LinkedIn, Indeed and other job alerts arrive. Takes about 2 minutes.</DialogDescription>
        </DialogHeader>
        <ImapConnectForm {...props} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function ImapConnectForm({ mailbox, initialEmail, onOpenChange, onConnected, onUseOutlook, onUseForwarding, onBusyChange }: ImapConnectDialogProps & { onBusyChange: (b: boolean) => void }) {
  const ids = useId();
  const created = useSourceCreated();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [choice, setChoice] = useState<string | null>(null); // null = detect from the email address
  const [appPassword, setAppPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [folder, setFolder] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [error, setError] = useState<string | null>(null);

  const presets = useMemo(() => (Array.isArray(mailbox.imapPresets) ? mailbox.imapPresets.filter((p) => p && typeof p.id === "string") : []), [mailbox.imapPresets]);
  const selectable = presets.filter((p) => !isMicrosoftPreset(p));
  const guessed = guessPreset(email, presets);
  const presetId = choice ?? guessed ?? "";
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const isMicrosoft = presetId === "microsoft" || (preset ? isMicrosoftPreset(preset) : false);
  const isCustom = presetId === "custom" && mailbox.customImapAllowed;
  const notes = presetNotes(preset);
  const emailValid = EMAIL_RE.test(email.trim());

  const connect = useMutation({
    mutationFn: () => {
      // Providers show app passwords in groups ("abcd efgh ijkl mnop"); the spaces are not part of it.
      const password = isCustom ? appPassword : appPassword.replace(/\s+/g, "");
      return api<FeedView>("/api/job-feeds/mailbox/imap", {
        body: {
          preset: presetId,
          email: email.trim(),
          appPassword: password,
          consent: true,
          ...(folder.trim() ? { folder: folder.trim() } : {}),
          ...(isCustom ? { host: host.trim(), port: Number(port) || 993 } : {}),
        },
      });
    },
    onSuccess: (feed) => {
      setAppPassword("");
      created(`Mailbox connected. Checking your job alerts now - new jobs will appear in your inbox.`);
      onConnected?.(feed);
      onOpenChange(false);
    },
    onError: (e) => {
      const field = e instanceof ApiClientError && e.fieldErrors ? Object.values(e.fieldErrors)[0]?.[0] : null;
      setError(field ?? errorMessage(e));
    },
  });

  useEffect(() => onBusyChange(connect.isPending), [connect.isPending, onBusyChange]);

  const canSubmit = emailValid && !!presetId && !isMicrosoft && (!!preset || isCustom) && appPassword.trim().length >= 4 && consent && (!isCustom || host.trim().length > 3) && !connect.isPending;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (canSubmit) connect.mutate();
      }}
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-email`}>Email address</Label>
          <Input
            id={`${ids}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@gmail.com"
            aria-invalid={email.length > 3 && !emailValid ? true : undefined}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-preset`}>Email provider</Label>
          <NativeSelect id={`${ids}-preset`} value={presetId} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose your provider</option>
            {selectable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="microsoft">Outlook, Hotmail or Live (Microsoft)</option>
            {mailbox.customImapAllowed ? <option value="custom">Other (custom IMAP server)</option> : null}
          </NativeSelect>
          {choice == null && guessed ? <p className="text-xs text-muted-foreground">Detected from your email address.</p> : null}
        </div>
      </div>

      {isMicrosoft ? (
        <Alert variant="warning">
          <AlertTitle>Outlook and Hotmail need Microsoft sign-in</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Microsoft no longer accepts app passwords for Outlook.com, Hotmail, Live and Microsoft 365 mailboxes.</p>
            {mailbox.outlookAvailable ? (
              onUseOutlook ? (
                <Button type="button" size="sm" onClick={() => onUseOutlook(email.trim())}>
                  Connect Outlook / Hotmail instead
                </Button>
              ) : (
                <p>
                  Use <strong>Connect Outlook / Hotmail</strong> on the{" "}
                  <Link href="/jobs/sources#job-alerts" className="font-medium underline">
                    Job sources page
                  </Link>
                  .
                </p>
              )
            ) : mailbox.forwardingAvailable ? (
              onUseForwarding ? (
                <Button type="button" size="sm" variant="outline" onClick={onUseForwarding}>
                  Forward alerts to your private address instead
                </Button>
              ) : (
                <p>
                  Forward your job alerts to your private ApplyWise address instead - set it up on the{" "}
                  <Link href="/jobs/sources#job-alerts" className="font-medium underline">
                    Job sources page
                  </Link>
                  .
                </p>
              )
            ) : (
              <p>Outlook sign-in is not available on this ApplyWise server yet. Until then, send your job alerts to a Gmail, Yahoo or Zoho address and connect that one.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {!isMicrosoft && (preset || isCustom) ? (
        <ol className="space-y-4">
          <li className="space-y-2">
            <p className="text-sm font-medium">
              <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground" aria-hidden="true">
                1
              </span>
              {isCustom ? "Get an app password (or IMAP password) from your email provider" : `Create an app password in your ${preset?.label ?? "email"} account`}
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
              <label htmlFor={`${ids}-pw`}>Paste the app password</label>
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
                Not your normal email password. It is stored encrypted and never shown again.
              </p>
            </div>
          </li>
          {isCustom ? (
            <li className="grid gap-3 pl-8 sm:grid-cols-[1fr_120px]">
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-host`}>IMAP server</Label>
                <Input id={`${ids}-host`} value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" autoCapitalize="none" spellCheck={false} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-port`}>Port</Label>
                <Input id={`${ids}-port`} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
              </div>
            </li>
          ) : null}
          <li className="space-y-2">
            <p className="text-sm font-medium">
              <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground" aria-hidden="true">
                3
              </span>
              Allow ApplyWise to read your job alerts
            </p>
            <label className="flex items-start gap-3 pl-8 text-sm">
              <Checkbox checked={consent} onCheckedChange={(c) => setConsent(c === true)} className="mt-0.5" aria-label={CONSENT_TEXT} />
              <span>{CONSENT_TEXT}</span>
            </label>
          </li>
        </ol>
      ) : null}

      {!isMicrosoft && (preset || isCustom) ? (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none font-medium">Advanced: job alerts go to a separate folder or label</summary>
          <div className="mt-3 space-y-1.5">
            <Label htmlFor={`${ids}-folder`}>Folder or label name</Label>
            <Input id={`${ids}-folder`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="INBOX" autoCapitalize="none" spellCheck={false} />
            <p className="text-xs text-muted-foreground">Leave empty to use your inbox.</p>
          </div>
        </details>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not connect</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Read-only. ApplyWise only downloads emails from known job sites and keeps just the job details. Remove the mailbox any time.
      </p>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={connect.isPending}>
          Cancel
        </Button>
        {!isMicrosoft ? (
          <Button type="submit" disabled={!canSubmit}>
            {connect.isPending ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" /> Checking your mailbox...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        ) : null}
      </DialogFooter>
      {connect.isPending ? (
        <p className="text-right text-xs text-muted-foreground" role="status">
          Signing in and looking for job alerts. This can take up to 30 seconds.
        </p>
      ) : null}
    </form>
  );
}
