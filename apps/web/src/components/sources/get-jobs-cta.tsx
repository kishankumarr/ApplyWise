import Link from "next/link";
import { BellRing, Building2, Radar, SearchCheck } from "lucide-react";
import { buttonVariants, Card, CardContent, cn } from "@applywise/ui";

/**
 * "Get jobs automatically" call-to-action, shown while the user has no job sources.
 * No hooks, so it renders in server components (dashboard) and client components (inbox).
 */
export function GetJobsCta({ className, compact = false }: { className?: string; compact?: boolean }) {
  const benefits = [
    { icon: BellRing, text: "Your Naukri, LinkedIn, Indeed and Foundit job alerts, picked up from your email" },
    { icon: Building2, text: "New openings from companies you follow, straight from their careers pages" },
    { icon: SearchCheck, text: "Saved searches for your target roles and cities, checked every few hours" },
  ];
  return (
    <Card className={cn("border-primary/40 bg-primary/5", className)} data-testid="get-jobs-cta">
      <CardContent className={cn("flex flex-col gap-4 md:flex-row md:items-center md:justify-between", compact ? "p-4" : "p-5")}>
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-lg font-semibold">
            <Radar className="h-5 w-5 text-primary" aria-hidden="true" /> Get jobs automatically
          </p>
          <ul className="space-y-1.5 text-sm">
            {benefits.map((b) => (
              <li key={b.text} className="flex items-start gap-2">
                <b.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                {b.text}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">You review every job and apply yourself - nothing is ever submitted for you.</p>
        </div>
        <Link href="/jobs/sources" className={cn(buttonVariants({ size: "lg" }), "shrink-0")}>
          Set up job sources
        </Link>
      </CardContent>
    </Card>
  );
}
