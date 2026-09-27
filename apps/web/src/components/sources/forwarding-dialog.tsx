"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, MailCheck, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { FeedView, ForwardingConfirmation, MailboxOptions } from "@/lib/client-types";
import { timeAgo } from "@/lib/format";
import { CopyButton } from "./copy-button";
import { gmailFilterQuery, pendingConfirmation } from "./feed-utils";
import { FEEDS_KEY } from "./use-job-feeds";

const GMAIL_FORWARDING_SETTINGS = "https://mail.google.com/mail/u/0/#settings/fwdandpop";

const external = "inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent";

/** Gmail's confirmation email arrived at the private address: the user confirms it in their own account. */
export function ForwardingConfirmationAlert({ confirmation }: { confirmation: ForwardingConfirmation }) {
  return (
    <Alert variant="info" data-testid="forwarding-confirmation">
      <MailCheck className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Confirm Gmail forwarding</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          Gmail sent a confirmation to your ApplyWise address {timeAgo(confirmation.receivedAt)}
          {confirmation.requester ? (
            <>
              {" "}
              for <strong>{confirmation.requester}</strong>
            </>
          ) : null}
          . Confirm it yourself in Gmail - ApplyWise never does this for you.
        </p>
        {confirmation.code ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">Confirmation code:</span>
            <code className="rounded-md border bg-background px-3 py-1.5 font-mono text-xl font-bold tracking-widest">{confirmation.code}</code>
            <CopyButton value={confirmation.code} what="confirmation code" />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {confirmation.confirmUrl ? (
            <a href={confirmation.confirmUrl} target="_blank" rel="noopener noreferrer" className={external}>
              Open confirmation in Gmail <ExternalLink className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
          <a href={GMAIL_FORWARDING_SETTINGS} target="_blank" rel="noopener noreferrer" className={external}>
            Enter the code in Gmail settings <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
        <p className="text-xs">After confirming, keep &quot;Disable forwarding&quot; selected on that page and create the filter below.</p>
      </AlertDescription>
    </Alert>
  );
}

export function ForwardingDialog({ open, onOpenChange, mailbox, feed }: { open: boolean; onOpenChange: (o: boolean) => void; mailbox: MailboxOptions; feed: FeedView | null }) {
  const qc = useQueryClient();
  const [created, setCreated] = useState<FeedView | null>(null);
  const current = feed ?? created;
  const address = current && typeof current.config.address === "string" ? current.config.address : null;
  const query = gmailFilterQuery(Array.isArray(mailbox.senderDomains) ? mailbox.senderDomains : []);
  const confirmation = pendingConfirmation(current);
  const alertsArriving = !!current?.lastSyncAt;

  const create = useMutation({
    mutationFn: () => api<FeedView>("/api/job-feeds/mailbox/forwarding", { body: {} }),
    onSuccess: (f) => {
      setCreated(f);
      void qc.invalidateQueries({ queryKey: FEEDS_KEY });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Forward job alerts to your private address</DialogTitle>
          <DialogDescription>
            Gmail forwards only your job-alert emails to a private ApplyWise address. No password or sign-in is shared with ApplyWise.
          </DialogDescription>
        </DialogHeader>

        {!address ? (
          <div className="space-y-4">
            <p className="text-sm">First, create your private forwarding address. Only you know it, and you can delete it any time.</p>
            {create.error ? (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage(create.error)}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null} Create my address
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-5 text-sm">
            <div className="space-y-1.5">
              <p className="font-medium">Your private ApplyWise address</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded-md border bg-muted px-3 py-2 text-sm" data-testid="forwarding-address">
                  {address}
                </code>
                <CopyButton value={address} what="forwarding address" />
              </div>
            </div>

            {confirmation ? <ForwardingConfirmationAlert confirmation={confirmation} /> : null}
            {alertsArriving ? (
              <p className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100" data-testid="forwarding-working">
                <MailCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Forwarding works: the last job alert arrived {timeAgo(current?.lastSyncAt ?? null)}. The steps below are only needed to add another Gmail account.</span>
              </p>
            ) : null}

            <ol className="space-y-4">
              <Step n={1} title="Add the address as a forwarding address in Gmail">
                <a href={GMAIL_FORWARDING_SETTINGS} target="_blank" rel="noopener noreferrer" className={external}>
                  Open Gmail forwarding settings <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
                <p>
                  Click <strong>Add a forwarding address</strong>, paste your ApplyWise address, then <strong>Next</strong>, <strong>Proceed</strong> and <strong>OK</strong>.
                </p>
              </Step>
              <Step n={2} title="Confirm the forwarding">
                <p>
                  Gmail emails a confirmation code to ApplyWise. It appears {confirmation ? "above" : "on the Job sources page within a minute or two"}. Open it and confirm it in your own Google account.
                </p>
              </Step>
              <Step n={3} title="Create a filter that forwards only job alerts">
                {query ? (
                  <>
                    <p>Copy this search:</p>
                    <div className="flex flex-wrap items-start gap-2">
                      <code className="max-h-28 min-w-0 flex-1 overflow-y-auto break-all rounded-md border bg-muted px-3 py-2 text-xs" data-testid="gmail-filter-query">
                        {query}
                      </code>
                      <CopyButton value={query} what="filter search" />
                    </div>
                  </>
                ) : null}
                <p>
                  In Gmail, paste it into the search bar, click the <strong>Show search options</strong> icon at the right of the search bar, then <strong>Create filter</strong>. Tick{" "}
                  <strong>Forward it to</strong>, choose your ApplyWise address and click <strong>Create filter</strong>.
                </p>
              </Step>
            </ol>

            <Alert variant="warning">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Never forward all your email</AlertTitle>
              <AlertDescription>
                On the forwarding settings page keep <strong>Disable forwarding</strong> selected. Do not choose &quot;Forward a copy of incoming mail to...&quot; - only the filter should forward, and only job alerts.
              </AlertDescription>
            </Alert>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Using Outlook.com or Hotmail?{" "}
                {mailbox.outlookAvailable ? (
                  <>
                    The easiest way is <strong>Connect Outlook / Hotmail</strong>. To forward instead,{" "}
                  </>
                ) : null}
                {mailbox.outlookAvailable ? "create" : "Create"} a rule for emails from the same job sites and choose <strong>Redirect to</strong> (not &quot;Forward to&quot;) with this address, so the job site stays the sender.
              </p>
              <p>
                Using Yahoo Mail? Free Yahoo accounts cannot forward automatically - use <strong>Connect email with an app password</strong> instead.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="space-y-2">
      <p className="font-medium">
        <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground" aria-hidden="true">
          {n}
        </span>
        {title}
      </p>
      <div className="space-y-2 pl-8 text-muted-foreground">{children}</div>
    </li>
  );
}
