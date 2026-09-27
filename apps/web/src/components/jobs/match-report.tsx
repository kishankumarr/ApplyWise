import type { JobMatchReport, MatchEvidence } from "@applywise/types";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@applywise/ui";
import { scoreVariant } from "@/lib/format";

const REC_LABEL = { apply: "Apply", apply_with_caution: "Apply with caution", do_not_prioritize: "Do not prioritise" } as const;
const MATCH_LABEL: Record<MatchEvidence["matchType"], string> = { exact: "Exact", related: "Related", unverified: "Unverified claim", missing: "Missing" };
const LEVEL_LABEL: Record<MatchEvidence["evidenceLevel"], string> = {
  experience: "Verified experience",
  project: "Verified project",
  questionnaire: "Your answer",
  skills_section: "Skills list only",
  unverified: "Unverified CV claim",
  none: "—",
};

export function MatchReportCard({ report, disclaimer }: { report: JobMatchReport; disclaimer: string }) {
  const positive = report.scoreFactors.filter((f) => f.key !== "mandatory_gap_penalty");
  const penalty = report.scoreFactors.find((f) => f.key === "mandatory_gap_penalty");
  return (
    <Card data-testid="match-report">
      <CardHeader>
        <CardDescription>Estimated resume-to-job match</CardDescription>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-4xl" data-testid="match-score">
            {report.estimatedMatchScore}
            <span className="text-base font-normal text-muted-foreground">/100</span>
          </CardTitle>
          <Badge variant={scoreVariant(report.scoreLabel)} className="capitalize">
            {report.scoreLabel}
          </Badge>
          <Badge variant="outline">{REC_LABEL[report.applicationRecommendation]}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{disclaimer}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Score composition</h3>
          <ul className="space-y-2" aria-label="Score composition">
            {positive.map((f) => (
              <li key={f.key}>
                <div className="flex justify-between text-sm">
                  <span>{f.label}</span>
                  <span className="tabular-nums">
                    {f.points} / {f.maxPoints}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-secondary" aria-hidden="true">
                  <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, (f.points / f.maxPoints) * 100)}%` }} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.explanation}</p>
              </li>
            ))}
            {penalty ? (
              <li className="text-sm">
                <div className="flex justify-between">
                  <span>{penalty.label}</span>
                  <span className="tabular-nums text-destructive">{penalty.points}</span>
                </div>
                <p className="text-xs text-muted-foreground">{penalty.explanation}</p>
              </li>
            ) : null}
          </ul>
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <p>
            <strong>Experience fit:</strong> {report.yoeFit.explanation}
          </p>
          <p>
            <strong>Location fit:</strong> {report.locationFit.explanation}
          </p>
        </div>
        {report.risks.length ? (
          <div>
            <h3 className="text-sm font-semibold">Risks</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
              {report.risks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {report.resumeImprovements.length ? (
          <div>
            <h3 className="text-sm font-semibold">Resume improvements (truthful only)</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
              {report.resumeImprovements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {report.resumeFormatWarnings.length ? (
          <div>
            <h3 className="text-sm font-semibold">Format warnings</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
              {report.resumeFormatWarnings.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function RequirementMatrix({ report }: { report: JobMatchReport }) {
  const rows = [...report.exactMatches, ...report.relatedMatches, ...report.unverifiedMatches, ...report.missingMandatoryRequirements, ...report.missingPreferredRequirements];
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.canonicalName}:${r.required}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => Number(b.required) - Number(a.required) || Number(b.mandatory) - Number(a.mandatory));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Requirement matrix</CardTitle>
        <CardDescription>Exact matching evidence from your verified facts. Related technology earns partial credit only.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table data-testid="requirement-matrix">
          <TableHeader>
            <TableRow>
              <TableHead>Requirement</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Match</TableHead>
              <TableHead>Evidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {unique.map((r) => (
              <TableRow key={`${r.canonicalName}-${r.required}`}>
                <TableCell className="font-medium">
                  {r.requirement}
                  {r.mandatory ? <Badge variant="destructive" className="ml-2 text-[10px]">Mandatory</Badge> : null}
                </TableCell>
                <TableCell className="text-sm">{r.required ? "Required" : "Preferred"}</TableCell>
                <TableCell>
                  <Badge variant={r.matchType === "exact" ? "success" : r.matchType === "missing" ? "secondary" : "warning"}>{MATCH_LABEL[r.matchType]}</Badge>
                  {r.relatedVia ? <p className="mt-1 text-xs text-muted-foreground">via {r.relatedVia}</p> : null}
                </TableCell>
                <TableCell className="max-w-md text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{LEVEL_LABEL[r.evidenceLevel]}</span>
                  {r.evidenceText[0] ? <span className="block truncate" title={r.evidenceText[0]}>“{r.evidenceText[0]}”</span> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
