import Link from "next/link";
import { MANUAL_ACTION_REASON_LABELS, type AutomationDecision, type ManualActionReason } from "@applywise/types";
import { Badge, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@applywise/ui";
import { formatDateTime, platformLabel, statusLabel, timeAgo } from "@/lib/format";
import {
  applicationMethodLabel,
  decisionLabel,
  decisionVariant,
  isPipelineStatus,
  pipelineNextAction,
  statusBadgeVariant,
  type ApplicationListView,
  type DateLike,
} from "./application-labels";

/** One row of GET /api/applications (dates may be Date objects when rendered on the server). */
export interface ApplicationRow {
  id: string;
  status: string;
  job: { id: string; title: string; company: string; platform: string; locations: string[]; isDemo: boolean };
  preparationError: string | null;
  updatedAt: DateLike;
  origin: "USER" | "AUTOMATION";
  mode: string | null;
  automationDecision: AutomationDecision | null;
  matchScore: number | null;
  source: string | null;
  appliedAt: DateLike | null;
  method: string | null;
  resumeLabel: string | null;
  manualActionReason: ManualActionReason | null;
  nextAction: string;
}

const VIEW_CAPTIONS: Record<ApplicationListView, string> = {
  active: "Active applications",
  pipeline: "Jobs in the automation pipeline",
  all: "All applications",
};

const nextStep = (a: ApplicationRow) => a.nextAction || pipelineNextAction(a.status, a.automationDecision) || "—";
const sourceLabel = (a: ApplicationRow) => a.source ?? platformLabel(a.job.platform);

function MatchScore({ score }: { score: number | null }) {
  if (score == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="tabular-nums">
      <span className="font-medium">{Math.round(score)}</span>
      <span className="text-xs text-muted-foreground">/100</span>
      <span className="sr-only"> match score</span>
    </span>
  );
}

function StatusCell({ a }: { a: ApplicationRow }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant={statusBadgeVariant(a.status)}>{statusLabel(a.status)}</Badge>
        {isPipelineStatus(a.status) && a.automationDecision ? <Badge variant={decisionVariant(a.automationDecision)}>{decisionLabel(a.automationDecision)}</Badge> : null}
      </div>
      {a.manualActionReason ? <p className="text-xs text-amber-700 dark:text-amber-300">{MANUAL_ACTION_REASON_LABELS[a.manualActionReason] ?? a.manualActionReason}</p> : null}
      {a.preparationError ? <p className="text-xs text-destructive">Preparation failed</p> : null}
    </div>
  );
}

/** Applications list: a table on md+ screens, cards on phones. */
export function ApplicationsTable({ rows, view }: { rows: ApplicationRow[]; view: ApplicationListView }) {
  return (
    <>
      <Card className="hidden md:block">
        <Table>
          <caption className="sr-only">{VIEW_CAPTIONS[view]}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Company</TableHead>
              <TableHead scope="col">Role</TableHead>
              <TableHead scope="col">Match</TableHead>
              <TableHead scope="col" className="hidden xl:table-cell">
                Source
              </TableHead>
              <TableHead scope="col" className="hidden lg:table-cell">
                Applied at
              </TableHead>
              <TableHead scope="col" className="hidden lg:table-cell">
                Application method
              </TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="hidden xl:table-cell">
                Resume
              </TableHead>
              <TableHead scope="col" className="hidden xl:table-cell">
                Last update
              </TableHead>
              <TableHead scope="col">Next action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id} data-testid="application-row">
                <TableCell className="max-w-[12rem]">
                  <span className="block truncate" title={a.job.company}>
                    {a.job.company}
                  </span>
                  {a.job.isDemo ? (
                    <Badge variant="warning" className="mt-1">
                      Demo
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-[10rem] max-w-[18rem]">
                  <Link href={`/applications/${a.id}`} className="font-medium hover:underline">
                    {a.job.title}
                  </Link>
                  {a.job.locations.length ? <p className="truncate text-xs text-muted-foreground">{a.job.locations.slice(0, 2).join(", ")}</p> : null}
                </TableCell>
                <TableCell>
                  <MatchScore score={a.matchScore} />
                </TableCell>
                <TableCell className="hidden max-w-[10rem] truncate xl:table-cell">{sourceLabel(a)}</TableCell>
                <TableCell className="hidden whitespace-nowrap lg:table-cell">{a.appliedAt ? formatDateTime(a.appliedAt) : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="hidden lg:table-cell">{applicationMethodLabel(a)}</TableCell>
                <TableCell>
                  <StatusCell a={a} />
                </TableCell>
                <TableCell className="hidden max-w-[10rem] xl:table-cell">
                  {a.resumeLabel ? (
                    <span className="block truncate" title={a.resumeLabel}>
                      {a.resumeLabel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap xl:table-cell">
                  <time dateTime={new Date(a.updatedAt).toISOString()} title={formatDateTime(a.updatedAt)}>
                    {timeAgo(a.updatedAt)}
                  </time>
                </TableCell>
                <TableCell className="min-w-[10rem] text-sm">{nextStep(a)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ul className="space-y-3 md:hidden" aria-label={VIEW_CAPTIONS[view]}>
        {rows.map((a) => (
          <li key={a.id} className="rounded-lg border bg-card p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/applications/${a.id}`} className="font-medium hover:underline">
                  {a.job.title}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {a.job.company} · {sourceLabel(a)}
                  {a.job.isDemo ? " · Demo" : ""}
                </p>
              </div>
              <MatchScore score={a.matchScore} />
            </div>
            <div className="mt-2">
              <StatusCell a={a} />
            </div>
            <p className="mt-2">
              <span className="text-muted-foreground">Next: </span>
              {nextStep(a)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {applicationMethodLabel(a)}
              {a.appliedAt ? ` · applied ${formatDateTime(a.appliedAt)}` : ""}
              {a.resumeLabel ? ` · ${a.resumeLabel}` : ""} · updated {timeAgo(a.updatedAt)}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
