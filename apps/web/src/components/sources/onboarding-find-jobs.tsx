"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2, Mail } from "lucide-react";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, cn, Skeleton, toast } from "@applywise/ui";
import { errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { followCompany } from "./companies-section";
import { boardKey, companyJobs, companyName } from "./feed-utils";
import { ForwardingDialog } from "./forwarding-dialog";
import { ImapConnectDialog } from "./imap-connect-dialog";
import { OutlookConnectDialog } from "./outlook-connect-dialog";
import { createSearch, suggestionKey } from "./searches-section";
import { boostFeedPolling, FEEDS_KEY, useJobFeeds } from "./use-job-feeds";

const TOP_COMPANIES = 10;

type MailDialog = { kind: "imap" | "outlook" | "forwarding"; email?: string } | null;

/**
 * Onboarding step "Find jobs": a compact version of the Job sources page so new users leave
 * onboarding with jobs already on their way (suggested searches, job-alert mailbox, companies).
 */
/** `onDone(sources)`: how many job sources the user has after this step (0 when skipped without any). */
export function FindJobsStep({ onBack, onDone }: { onBack: () => void; onDone: (sources: number) => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useJobFeeds({ fresh: true });
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set()); // suggestions start checked
  const [companies, setCompanies] = useState<Set<string>>(new Set()); // companies start unchecked
  const [mailDialog, setMailDialog] = useState<MailDialog>(null);
  const [busy, setBusy] = useState(false);

  const suggestions = data?.searchSuggestions ?? [];
  const chosenSearches = suggestions.filter((s) => !unchecked.has(suggestionKey(s)));
  const popular = (data?.suggestedCompanies ?? []).filter((c) => c && c.slug).slice(0, TOP_COMPANIES);
  const chosenCompanies = popular.filter((c) => companies.has(boardKey(c.provider, c.slug)));
  const mailboxes = data?.feeds.filter((f) => f.kind === "MAILBOX") ?? [];
  const forwarding = mailboxes.find((f) => f.provider === "forwarding") ?? null;
  const savedSearchCount = data?.feeds.filter((f) => f.kind === "SEARCH").length ?? 0;
  const searchAvailable = !!data?.searchProviders.some((p) => p.available);
  const closeMail = (o: boolean) => (o ? undefined : setMailDialog(null));
  const total = chosenSearches.length + chosenCompanies.length;
  const existing = data?.feeds.length ?? 0;

  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(key);
    else n.delete(key);
    return n;
  };

  const start = async () => {
    if (total === 0) return onDone(existing);
    setBusy(true);
    let added = 0;
    const errors: string[] = [];
    for (const s of chosenSearches) {
      try {
        await createSearch({ provider: s.provider, keywords: s.keywords, location: s.location, remoteOnly: s.remoteOnly });
        added++;
      } catch (e) {
        errors.push(errorMessage(e));
        break; // usually "limit reached" or "not configured": the rest would fail the same way
      }
    }
    for (const c of chosenCompanies) {
      try {
        await followCompany({ provider: c.provider, slug: c.slug, companyName: companyName(c), onlyRelevant: true });
        added++;
      } catch (e) {
        errors.push(`${companyName(c)}: ${errorMessage(e)}`);
      }
    }
    setBusy(false);
    boostFeedPolling();
    void qc.invalidateQueries({ queryKey: FEEDS_KEY });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    if (added) toast.success(`${plural(added, "job source")} added. ApplyWise is looking for jobs now - they will be in your inbox shortly.`);
    if (errors.length) toast.error(errors.slice(0, 2).join(" "));
    onDone(existing + added);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Find jobs automatically</CardTitle>
        <CardDescription>ApplyWise checks these sources every few hours and adds matching jobs to your inbox. You still review and apply yourself.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-10 w-64" />
          </div>
        ) : error || !data ? (
          <Alert variant="warning">
            <AlertDescription>Job sources could not be loaded right now ({errorMessage(error)}). You can set them up later under Jobs, then Job sources.</AlertDescription>
          </Alert>
        ) : (
          <>
            <section className="space-y-2" aria-labelledby="fj-searches">
              <h3 id="fj-searches" className="font-semibold">
                Searches for your target roles
              </h3>
              {suggestions.length ? (
                <ul className="space-y-2">
                  {suggestions.map((s) => {
                    const key = suggestionKey(s);
                    const provider = data.searchProviders.find((p) => p.id === s.provider);
                    return (
                      <li key={key}>
                        <label className="flex items-center gap-3 text-sm">
                          <Checkbox checked={!unchecked.has(key)} onCheckedChange={(c) => setUnchecked((u) => toggle(u, key, c !== true))} aria-label={`Search for ${s.label}`} />
                          <span>
                            {s.label}
                            {provider ? <span className="text-muted-foreground"> · {provider.label}</span> : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : savedSearchCount > 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> Your saved searches are set up ({savedSearchCount}). ApplyWise checks them twice a day.
                </p>
              ) : !data.hasProfilePrefs ? (
                <p className="text-sm text-muted-foreground">Add target roles in the previous steps to get search suggestions.</p>
              ) : !searchAvailable ? (
                <p className="text-sm text-muted-foreground">Automatic job searches are not available on this server yet - job alerts below still work.</p>
              ) : (
                <p className="text-sm text-muted-foreground">No search suggestions for your target roles right now. You can add your own searches later on the Job sources page.</p>
              )}
            </section>

            <section className="space-y-2" aria-labelledby="fj-alerts">
              <h3 id="fj-alerts" className="font-semibold">
                Your Naukri, LinkedIn and Indeed job alerts
              </h3>
              <p className="text-sm text-muted-foreground">Already get job alerts by email? Connect that mailbox and ApplyWise adds every job from them. Read-only; other emails are never downloaded.</p>
              {mailboxes.length ? (
                <ul className="space-y-1 text-sm">
                  {mailboxes.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> {m.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setMailDialog({ kind: "imap" })} disabled={mailboxes.length >= (data.limits?.MAILBOX ?? 2)}>
                  <KeyRound aria-hidden="true" /> Connect your job-alert email
                </Button>
                {data.mailbox.outlookAvailable ? (
                  <Button variant="ghost" onClick={() => setMailDialog({ kind: "outlook" })} disabled={mailboxes.length >= (data.limits?.MAILBOX ?? 2)}>
                    Connect Outlook / Hotmail
                  </Button>
                ) : null}
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  More options (Google sign-in, forwarding) and alert setup guides are on the{" "}
                  <Link href="/jobs/sources#job-alerts" target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
                    Job sources page
                    <span className="sr-only"> (opens in a new tab)</span>
                  </Link>
                  .
                </span>
              </p>
            </section>

            {popular.length ? (
              <section className="space-y-2" aria-labelledby="fj-companies">
                <h3 id="fj-companies" className="font-semibold">
                  Follow popular companies in India
                </h3>
                <p className="text-sm text-muted-foreground">Only openings that match your target roles are added.</p>
                <ul className="flex flex-wrap gap-2">
                  {popular.map((c) => {
                    const key = boardKey(c.provider, c.slug);
                    const on = companies.has(key);
                    const jobs = companyJobs(c);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => setCompanies((s) => toggle(s, key, !on))}
                          className={cn(
                            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                          )}
                        >
                          {on ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                          {companyName(c)}
                          {jobs != null ? <span className={on ? "opacity-80" : "text-muted-foreground"}>· {plural(jobs, "job")}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <ImapConnectDialog
              open={mailDialog?.kind === "imap"}
              onOpenChange={closeMail}
              mailbox={data.mailbox}
              onUseOutlook={data.mailbox.outlookAvailable ? (email) => setMailDialog({ kind: "outlook", email }) : undefined}
              onUseForwarding={data.mailbox.forwardingAvailable ? () => setMailDialog({ kind: "forwarding" }) : undefined}
            />
            {data.mailbox.outlookAvailable ? <OutlookConnectDialog open={mailDialog?.kind === "outlook"} onOpenChange={closeMail} initialEmail={mailDialog?.email} /> : null}
            {data.mailbox.forwardingAvailable ? <ForwardingDialog open={mailDialog?.kind === "forwarding"} onOpenChange={closeMail} mailbox={data.mailbox} feed={forwarding} /> : null}
          </>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onDone(existing)} disabled={busy}>
              Skip for now
            </Button>
            <Button onClick={() => void start()} disabled={busy || isLoading}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {busy ? "Setting up..." : total ? `Start searching (${total})` : "Continue"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
