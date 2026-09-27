import { ShieldCheck } from "lucide-react";
import { Card } from "@applywise/ui";

const STEPS: { title: string; body: string }[] = [
  { title: "Discover", body: "Checks your job sources for new postings and merges duplicates across sites." },
  { title: "Match", body: "Scores each job against your verified profile - the same score you see in Jobs." },
  { title: "Rules", body: "Your thresholds and rules decide: ignore, recommend, review or auto-eligible." },
  { title: "Prepare", body: "Picks your best resume, tailors it and answers screening questions from verified facts." },
  { title: "Review / Auto", body: "Manual and Review wait for you. Auto submits only where the source supports it and every check passes." },
  { title: "Track", body: "Follows confirmations, assessments, interviews and replies you forward to your private ApplyWise address, plus provider status updates." },
];

export function ControlHowItWorks() {
  return (
    <Card role="region" aria-labelledby="how-it-works-title" className="p-5">
      <h2 id="how-it-works-title" className="text-base font-semibold">
        How it works
      </h2>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-md border bg-muted/20 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                {i + 1}
              </span>
              {s.title}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 flex items-start gap-2 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <span>
          Only facts you have verified are ever used - nothing is invented. A CAPTCHA, sign-in wall, multi-factor prompt or an unanswered question always hands the
          application back to you.
        </span>
      </p>
    </Card>
  );
}
