import type { ReviewQueueItem } from "@applywise/types";
import { Badge } from "@applywise/ui";
import { scoreVariant } from "@/lib/format";

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Score, label, factor bars (points / maxPoints with explanations) and matched / missing skills. */
export function MatchBreakdown({ match, headingId }: { match: ReviewQueueItem["match"]; headingId: string }) {
  const matched = unique(match.matchedSkills);
  const missing = unique(match.missingSkills);
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-sm font-semibold">
        Match
      </h3>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{match.score ?? "—"}</span>
        <span className="text-sm text-muted-foreground">/100</span>
        {match.label ? (
          <Badge variant={scoreVariant(match.label)} className="capitalize">
            {match.label}
          </Badge>
        ) : null}
      </div>
      {match.summary ? <p className="text-sm text-muted-foreground">{match.summary}</p> : null}
      {match.score == null ? <p className="text-sm text-muted-foreground">This job has not been scored yet.</p> : null}

      {match.factors.length ? (
        <ul className="space-y-2" aria-label="Score factors">
          {match.factors.map((f) => {
            const penalty = f.points < 0;
            const bar = !penalty && f.maxPoints > 0;
            return (
              <li key={f.key}>
                <div className="flex justify-between gap-2 text-sm">
                  <span>{f.label}</span>
                  <span className={penalty ? "tabular-nums text-destructive" : "tabular-nums"}>
                    {bar ? `${f.points} / ${f.maxPoints}` : f.points}
                    {bar ? <span className="sr-only"> points</span> : null}
                  </span>
                </div>
                {bar ? (
                  <div className="mt-1 h-2 rounded-full bg-secondary" aria-hidden="true">
                    <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, (f.points / f.maxPoints) * 100))}%` }} />
                  </div>
                ) : null}
                {f.explanation ? <p className="mt-0.5 text-xs text-muted-foreground">{f.explanation}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {matched.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Matched skills</p>
          <ul className="flex flex-wrap gap-1" aria-label="Matched skills">
            {matched.map((s) => (
              <li key={s}>
                <Badge variant="success">{s}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {missing.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Missing skills</p>
          <ul className="flex flex-wrap gap-1" aria-label="Missing skills">
            {missing.map((s) => (
              <li key={s}>
                <Badge variant="outline">{s}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
