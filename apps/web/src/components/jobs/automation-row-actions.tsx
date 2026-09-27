"use client";

import Link from "next/link";
import { Bookmark, BookmarkCheck, EyeOff, Loader2 } from "lucide-react";
import { Button, buttonVariants, cn } from "@applywise/ui";
import type { JobListItem } from "@/lib/client-types";
import { statusLabel } from "@/lib/format";
import { APPROVED_UNSENT_STATUSES, PREPARABLE_STATUSES, RESOLVE_STATUSES } from "./automation-labels";

const ICON_BUTTON = "h-9 w-9";

/**
 * Row actions on the job matches table. The primary action follows the application status:
 * Prepare (not started / pipeline) -> Approve (ready for review) -> Approve + Apply (waiting for approval) ->
 * Apply on the application page (approved, not sent) -> Resolve (needs information / manual action / failed).
 * Approve and Apply only open a confirmation; nothing is sent from the table without it.
 */
export function JobRowActions({
  job,
  preparing,
  stateBusy,
  onPrepare,
  onApprove,
  onApply,
  onToggleSaved,
  onToggleIgnored,
}: {
  job: JobListItem;
  preparing: boolean;
  stateBusy: boolean;
  onPrepare: () => void;
  onApprove: () => void;
  onApply: () => void;
  onToggleSaved: () => void;
  onToggleIgnored: () => void;
}) {
  const s = job.applicationStatus;
  const name = `${job.title} at ${job.company}`;
  const appHref = job.applicationId ? `/applications/${job.applicationId}` : null;

  let primary: React.ReactNode = null;
  if (!s || PREPARABLE_STATUSES.includes(s)) {
    primary = (
      <Button
        size="sm"
        variant="outline"
        onClick={onPrepare}
        disabled={preparing}
        aria-label={`Prepare an application for ${name}`}
        title={s === "REJECTED_BY_RULES" ? "Your rules filtered this job out - you can still prepare an application yourself" : "Prepare drafts for your review"}
      >
        {preparing ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        Prepare
      </Button>
    );
  } else if (s === "READY_FOR_REVIEW") {
    primary = (
      <Button size="sm" onClick={onApprove} aria-label={`Approve the application for ${name}`} title="Review and approve (asks you to confirm first)">
        Approve
      </Button>
    );
  } else if (s === "WAITING_APPROVAL") {
    primary = (
      <>
        <Button size="sm" onClick={onApply} aria-label={`Apply to ${name}`} title="Approve and submit (asks you to confirm first)">
          Apply
        </Button>
      </>
    );
  } else if (appHref && APPROVED_UNSENT_STATUSES.includes(s)) {
    primary = (
      <Link href={appHref} className={cn(buttonVariants({ size: "sm" }))} aria-label={`Apply to ${name} (opens the application)`}>
        Apply
      </Link>
    );
  } else if (appHref && RESOLVE_STATUSES.includes(s)) {
    primary = (
      <Link href={appHref} className={cn(buttonVariants({ size: "sm", variant: "outline" }))} aria-label={`Resolve ${name}: ${statusLabel(s)}`}>
        Resolve
      </Link>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {primary}
      <div className="flex items-center">
        <Link href={`/jobs/${job.id}`} className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "px-2")} aria-label={`View ${name}`}>
          View
        </Link>
        <Button
          size="icon"
          variant="ghost"
          className={ICON_BUTTON}
          aria-label={`Save ${name}`}
          aria-pressed={job.saved}
          title={job.saved ? "Saved" : "Save job"}
          onClick={onToggleSaved}
          disabled={stateBusy}
        >
          {job.saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={ICON_BUTTON}
          aria-label={job.ignored ? `Unignore ${name}` : `Ignore ${name}`}
          title={job.ignored ? "Show this job again" : "Ignore job"}
          onClick={onToggleIgnored}
          disabled={stateBusy}
        >
          <EyeOff aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
