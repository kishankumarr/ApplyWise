"use client";

import { useState } from "react";
import { BellRing, ExternalLink, Forward, KeyRound, Mail } from "lucide-react";
import { Badge, Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, cn } from "@applywise/ui";
import type { FeedView, JobFeedsOverview } from "@/lib/client-types";
import { alertGuides, pendingConfirmation } from "./feed-utils";
import { FeedList } from "./feed-row";
import { ForwardingConfirmationAlert, ForwardingDialog } from "./forwarding-dialog";
import { ImapConnectDialog } from "./imap-connect-dialog";
import { OutlookConnectDialog } from "./outlook-connect-dialog";

type OpenDialog = { kind: "imap" | "outlook" | "forwarding"; email?: string } | null;

function Option({ icon: Icon, title, description, children }: { icon: typeof Mail; title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

export function AlertsSection({ data }: { data: JobFeedsOverview }) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const mailbox = data.mailbox;
  const guides = alertGuides(data);
  const mailboxes = data.feeds.filter((f) => f.kind === "MAILBOX");
  const forwarding: FeedView | null = mailboxes.find((f) => f.provider === "forwarding") ?? null;
  const limit = data.limits?.MAILBOX ?? 2;
  const atLimit = mailboxes.length >= limit;
  const confirmation = pendingConfirmation(forwarding);
  const close = (o: boolean) => (o ? undefined : setDialog(null));

  return (
    <Card id="job-alerts" className="scroll-mt-6 border-primary/40">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <BellRing className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold leading-tight tracking-tight">Your job alerts (Naukri, LinkedIn, Indeed, Foundit, ...)</h2>
          <Badge variant="info">Most jobs come from here</Badge>
        </div>
        <CardDescription>
          Job sites do not let apps read their pages, but they happily email you new jobs. Set up alerts once, connect the mailbox they arrive in, and ApplyWise adds every job from those emails to your inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <section aria-labelledby="alerts-step-1" className="space-y-3">
          <h3 id="alerts-step-1" className="font-semibold">
            Step 1. Create job alerts on the sites you use
          </h3>
          <p className="text-sm text-muted-foreground">Use your target role and city, choose daily emails, and send them to the email address you connect in step 2.</p>
          {guides.length ? (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {guides.map((g) => (
                <li key={g.key} className="rounded-md border">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="font-medium">{g.title}</span>
                    {g.createAlertUrl ? (
                      <a href={g.createAlertUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: "sm", variant: "outline" }), "h-8")}>
                        Create alert <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">on {g.title} (opens in a new tab)</span>
                      </a>
                    ) : null}
                  </div>
                  {g.steps?.length ? (
                    <details className="group border-t px-3 py-2">
                      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">How to set it up</summary>
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                        {g.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">Create job alerts on Naukri, LinkedIn, Indeed, Foundit or any job site you use. Search for your role and city, then choose &quot;Create job alert&quot; or &quot;Get jobs by email&quot;.</p>
          )}
        </section>

        <section aria-labelledby="alerts-step-2" className="space-y-4">
          <h3 id="alerts-step-2" className="font-semibold">
            Step 2. Connect the mailbox that receives them
          </h3>
          {confirmation ? <ForwardingConfirmationAlert confirmation={confirmation} /> : null}
          {atLimit ? <p className="text-sm text-muted-foreground">You have connected {limit} mailboxes, the maximum. Remove one below to connect another.</p> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <Option icon={KeyRound} title="Connect email with an app password" description="Gmail, Yahoo, iCloud, Zoho and more. Takes about 2 minutes.">
              <Button onClick={() => setDialog({ kind: "imap" })} disabled={atLimit}>
                Connect email with an app password
              </Button>
            </Option>
            {mailbox.gmailAvailable ? (
              <Option icon={Mail} title="Sign in with Google" description="One click for Gmail. Read-only access that you can revoke any time.">
                {atLimit ? (
                  <Button variant="outline" disabled>
                    Sign in with Google
                  </Button>
                ) : (
                  // A full page navigation (not <Link>): the route redirects to Google and must never be prefetched.
                  // eslint-disable-next-line @next/next/no-html-link-for-pages
                  <a href="/api/job-feeds/mailbox/gmail/start" className={buttonVariants({ variant: "outline" })}>
                    Sign in with Google
                  </a>
                )}
              </Option>
            ) : null}
            {mailbox.outlookAvailable ? (
              <Option icon={Mail} title="Connect Outlook / Hotmail" description="For Outlook.com, Hotmail, Live and Microsoft 365. You sign in at Microsoft with a one-time code.">
                <Button variant="outline" onClick={() => setDialog({ kind: "outlook" })} disabled={atLimit}>
                  Connect Outlook / Hotmail
                </Button>
              </Option>
            ) : null}
            {mailbox.forwardingAvailable ? (
              <Option icon={Forward} title="Forward alerts to your private address" description="No password needed: Gmail forwards only your job alerts to ApplyWise.">
                <Button variant="outline" onClick={() => setDialog({ kind: "forwarding" })} disabled={atLimit && !forwarding}>
                  {forwarding ? "Show forwarding setup" : "Forward alerts to your private address"}
                </Button>
              </Option>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Read-only and private: ApplyWise only downloads emails sent by job sites and keeps just the job details (title, company, location, link and a short summary). Your other emails are never downloaded or stored.
          </p>
          <FeedList feeds={mailboxes} title="Connected mailboxes" mailbox={mailbox} />
        </section>
      </CardContent>

      <ImapConnectDialog
        open={dialog?.kind === "imap"}
        onOpenChange={close}
        mailbox={mailbox}
        initialEmail={dialog?.email}
        onUseOutlook={(email) => setDialog({ kind: "outlook", email })}
        onUseForwarding={() => setDialog({ kind: "forwarding" })}
      />
      {mailbox.outlookAvailable ? <OutlookConnectDialog open={dialog?.kind === "outlook"} onOpenChange={close} initialEmail={dialog?.email} /> : null}
      {mailbox.forwardingAvailable ? <ForwardingDialog open={dialog?.kind === "forwarding"} onOpenChange={close} mailbox={mailbox} feed={forwarding} /> : null}
    </Card>
  );
}
