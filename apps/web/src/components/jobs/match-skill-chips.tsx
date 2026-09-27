import { Check, Minus } from "lucide-react";
import { Badge, cn } from "@applywise/ui";
import { EmptyValue } from "./automation-badges";

/**
 * Matched / missing requirement chips from the deterministic match report: at most `max` chips plus "+n"
 * (the rest are listed in the tooltip and for screen readers). No hooks: usable from server components.
 */
export function SkillChips({
  skills,
  tone,
  max = 3,
  showEmpty = true,
  className,
}: {
  skills: string[];
  tone: "matched" | "missing";
  max?: number;
  /** Render "—" when there are no skills (table cells); otherwise nothing. */
  showEmpty?: boolean;
  className?: string;
}) {
  const label = tone === "matched" ? "Matched skills" : "Missing skills";
  if (skills.length === 0) return showEmpty ? <EmptyValue label={`${label}: none`} /> : null;
  const shown = skills.slice(0, max);
  const rest = skills.slice(max);
  const Icon = tone === "matched" ? Check : Minus;
  return (
    <ul className={cn("flex flex-wrap items-center gap-1", className)} aria-label={label}>
      <li aria-hidden="true" className={tone === "matched" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
        <Icon className="h-3 w-3" />
      </li>
      {shown.map((s, i) => (
        <li key={`${s}-${i}`}>
          <Badge variant={tone === "matched" ? "success" : "warning"} className="px-1.5 py-0 text-[11px] font-medium">
            {s}
          </Badge>
        </li>
      ))}
      {rest.length ? (
        <li>
          <Badge variant="outline" className="cursor-help px-1.5 py-0 text-[11px] font-medium" title={rest.join(", ")}>
            <span aria-hidden="true">+{rest.length}</span>
            <span className="sr-only">and {rest.join(", ")}</span>
          </Badge>
        </li>
      ) : null}
    </ul>
  );
}
