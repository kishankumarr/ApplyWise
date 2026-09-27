import type { ApplicationMessageCategory } from "@applywise/types";
import { Badge } from "@applywise/ui";
import type { ApplicationView } from "@/lib/client-types";
import { formatDateTime, statusLabel } from "@/lib/format";
import { MESSAGE_CATEGORY_LABELS, actorLabel, actorVariant, percent, type BadgeVariant } from "./application-labels";

const CATEGORY_VARIANTS: Record<ApplicationMessageCategory, BadgeVariant> = {
  APPLICATION_CONFIRMATION: "outline",
  RECRUITER_RESPONSE: "info",
  ASSESSMENT: "info",
  INTERVIEW: "info",
  REJECTION: "secondary",
  OFFER: "success",
  OTHER: "outline",
};

const time = (iso: string) => new Date(iso).getTime() || 0;

/** Complete event history (newest first) plus the employer status emails linked to the application. */
export function ApplicationTimeline({ events, messages }: Pick<ApplicationView, "events" | "messages">) {
  const sorted = [...events].sort((a, b) => time(b.createdAt) - time(a.createdAt));
  return (
    <div className="space-y-6">
      <section aria-labelledby="timeline-activity-heading" className="space-y-2">
        <h3 id="timeline-activity-heading" className="text-sm font-medium">
          Activity <span className="font-normal text-muted-foreground">(newest first)</span>
        </h3>
        <ol className="space-y-3 border-l pl-4" data-testid="timeline">
          {sorted.length === 0 ? <li className="text-sm text-muted-foreground">No activity yet.</li> : null}
          {sorted.map((e) => (
            <li key={e.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={actorVariant(e.actor)}>{actorLabel(e.actor)}</Badge>
                {e.toStatus ? (
                  <span className="text-xs text-muted-foreground">
                    {e.fromStatus ? statusLabel(e.fromStatus) : "New"}
                    <span aria-hidden="true"> → </span>
                    <span className="sr-only"> changed to </span>
                    {statusLabel(e.toStatus)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 break-words">{e.message}</p>
              <p className="text-xs text-muted-foreground">
                <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="timeline-emails-heading" className="space-y-2">
        <h3 id="timeline-emails-heading" className="text-sm font-medium">
          Status emails
        </h3>
        <p className="text-xs text-muted-foreground">Employer emails linked to this application (forwarded to your private ApplyWise address, or from the provider's status updates). Only the category, a shortened subject and the sender&apos;s domain are kept.</p>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No status emails linked yet.</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="status-emails">
            {messages.map((m) => (
              <li key={m.id} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={CATEGORY_VARIANTS[m.category] ?? "outline"}>{MESSAGE_CATEGORY_LABELS[m.category] ?? m.category}</Badge>
                  <span className="text-xs text-muted-foreground">{percent(m.confidence)} confidence</span>
                  {m.statusApplied ? <Badge variant="success">Updated the status</Badge> : <Badge variant="outline">Status not changed</Badge>}
                </div>
                <p className="break-words font-medium">{m.subject || "(no subject)"}</p>
                <p className="text-xs text-muted-foreground">
                  From {m.fromDomain ?? "an unknown sender"} · <time dateTime={m.receivedAt}>{formatDateTime(m.receivedAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
