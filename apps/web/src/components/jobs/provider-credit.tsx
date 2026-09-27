import { cn } from "@applywise/ui";

/**
 * Credit for jobs that came from a job-search API ("Jobs by Adzuna", "via Himalayas"): the
 * providers' terms ask for it wherever their jobs are shown. Renders nothing for other sources.
 * No hooks, so it works in server components (dashboard) and client components (inbox, job page).
 */
export function ProviderCredit({ attribution, url, className }: { attribution: string | null | undefined; url: string | null | undefined; className?: string }) {
  if (!attribution || !url || !/^https?:\/\//i.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground", className)}
      data-testid="job-attribution"
    >
      {attribution}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
