import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonVariants, cn } from "@applywise/ui";

/** Page numbers to show around the current page: 1 … 4 5 [6] 7 8 … 20. */
export function pageWindow(page: number, pageCount: number, radius = 1): (number | "gap")[] {
  const out: (number | "gap")[] = [];
  const from = Math.max(2, page - radius);
  const to = Math.min(pageCount - 1, page + radius);
  out.push(1);
  if (from > 2) out.push("gap");
  for (let p = from; p <= to; p++) out.push(p);
  if (to < pageCount - 1) out.push("gap");
  if (pageCount > 1) out.push(pageCount);
  return out;
}

export const pageCountOf = (total: number, pageSize: number) =>
  Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

/** "26–50 of 132". */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return "0 of 0";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return `${first}–${last} of ${total}`;
}

/**
 * Pagination control (no "use client": a server page can pass `hrefFor`, a client list `onPageChange`).
 * Link mode (`hrefFor`) for server-rendered pages keeps the page in the URL; button mode
 * (`onPageChange`) for client lists. Renders nothing when everything fits on one page.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPageChange,
  hrefFor,
  label = "Pagination",
  busy = false,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange?: (page: number) => void;
  hrefFor?: (page: number) => string;
  label?: string;
  busy?: boolean;
  className?: string;
}) {
  const pageCount = pageCountOf(total, pageSize);
  if (total <= pageSize && page <= 1) return null;
  const current = Math.min(Math.max(1, page), pageCount);

  const item = (
    target: number,
    content: React.ReactNode,
    opts: { ariaLabel: string; current?: boolean; disabled?: boolean },
  ) => {
    const cls = cn(
      buttonVariants({ variant: opts.current ? "default" : "outline", size: "sm" }),
      "min-w-9 tabular-nums",
      opts.disabled && "pointer-events-none opacity-50",
    );
    if (opts.disabled || opts.current) {
      return (
        <span
          className={cls}
          aria-label={opts.ariaLabel}
          aria-current={opts.current ? "page" : undefined}
          aria-disabled={opts.disabled ? true : undefined}
        >
          {content}
        </span>
      );
    }
    if (hrefFor) {
      return (
        <Link href={hrefFor(target)} className={cls} aria-label={opts.ariaLabel} scroll>
          {content}
        </Link>
      );
    }
    return (
      <button
        type="button"
        className={cls}
        aria-label={opts.ariaLabel}
        onClick={() => onPageChange?.(target)}
        disabled={busy}
      >
        {content}
      </button>
    );
  };

  return (
    <nav
      aria-label={label}
      className={cn("flex flex-wrap items-center justify-between gap-2 py-2", className)}
      data-testid="pager"
    >
      <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {rangeLabel(current, pageSize, total)}
        {busy ? " · loading…" : ""}
      </p>
      <ul className="flex flex-wrap items-center gap-1">
        <li>
          {item(
            current - 1,
            <>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Previous</span>
            </>,
            { ariaLabel: "Previous page", disabled: current <= 1 },
          )}
        </li>
        {pageWindow(current, pageCount).map((p, i) =>
          p === "gap" ? (
            <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-muted-foreground">
              …
            </li>
          ) : (
            <li key={p} className="hidden sm:block">
              {item(p, p, { ariaLabel: `Page ${p}`, current: p === current })}
            </li>
          ),
        )}
        <li>
          {item(
            current + 1,
            <>
              <span className="sr-only sm:not-sr-only">Next</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </>,
            { ariaLabel: "Next page", disabled: current >= pageCount },
          )}
        </li>
      </ul>
    </nav>
  );
}
