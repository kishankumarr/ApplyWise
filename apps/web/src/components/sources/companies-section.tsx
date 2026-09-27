"use client";

import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Building2, Check, ExternalLink, Loader2, Plus, Search } from "lucide-react";
import { Alert, AlertDescription, Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, Checkbox, cn, Input, Label, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { BoardProbe, FeedView, JobFeedsOverview, SuggestedCompany } from "@/lib/client-types";
import { plural } from "@/lib/format";
import { boardKey, companyJobs, companyName, followedBoards } from "./feed-utils";
import { FeedList } from "./feed-row";
import { useSourceCreated } from "./use-job-feeds";

export function followCompany(body: { provider: string; slug: string; companyName: string | null; onlyRelevant: boolean }) {
  return api<FeedView>("/api/job-feeds/boards", { body });
}

const SUGGESTED_VISIBLE = 12;

export function CompaniesSection({ data }: { data: JobFeedsOverview }) {
  const ids = useId();
  const created = useSourceCreated();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [onlyRelevant, setOnlyRelevant] = useState(true);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Followed a moment ago, until the refreshed overview lists it (then data.feeds is the only truth,
  // so a company removed later can be followed again).
  const [justFollowed, setJustFollowed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const boards = data.feeds.filter((f) => f.kind === "COMPANY_BOARD");
  const followed = followedBoards(data.feeds);
  const [seenFeeds, setSeenFeeds] = useState(data.feeds);
  if (seenFeeds !== data.feeds) {
    setSeenFeeds(data.feeds);
    if ([...justFollowed].some((k) => followed.has(k))) setJustFollowed(new Set([...justFollowed].filter((k) => !followed.has(k))));
  }
  const limit = data.limits?.COMPANY_BOARD ?? 60;
  const atLimit = boards.length >= limit;
  const atsLabel = (id: string) => data.boardProviders.find((b) => b.id === id)?.label ?? id;
  const supported = data.boardProviders.map((b) => b.label);

  const find = useMutation({
    mutationFn: (q: string) => api<{ boards: BoardProbe[] }>("/api/job-feeds/boards/find", { body: { query: q } }),
    onMutate: (q) => setSearched(q),
  });

  const follow = async (item: { provider: string; slug: string; companyName: string | null }) => {
    const key = boardKey(item.provider, item.slug);
    setPending((s) => new Set(s).add(key));
    try {
      await followCompany({ ...item, onlyRelevant });
      setJustFollowed((s) => new Set(s).add(key));
      created(`Following ${item.companyName ?? item.slug}. ${onlyRelevant ? "Jobs matching your target roles" : "Its new jobs"} will appear in your inbox.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const isFollowing = (provider: string, slug: string) => followed.has(boardKey(provider, slug)) || justFollowed.has(boardKey(provider, slug));
  const suggestions: SuggestedCompany[] = (Array.isArray(data.suggestedCompanies) ? data.suggestedCompanies : []).filter((c) => c && c.slug && !isFollowing(c.provider, c.slug));
  const visible = showAll ? suggestions : suggestions.slice(0, SUGGESTED_VISIBLE);
  const results = find.data?.boards ?? null;

  return (
    <Card id="companies" className="scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold leading-tight tracking-tight">Companies you follow</h2>
        </div>
        <CardDescription>
          Get new openings straight from a company&apos;s own careers page{supported.length ? ` (${supported.join(", ")})` : ""}. Checked twice a day.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            if (q.length >= 2 && !find.isPending) find.mutate(q);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-q`}>Company name or careers page URL</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id={`${ids}-q`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Razorpay or https://jobs.lever.co/company" className="sm:flex-1" />
              <Button type="submit" disabled={query.trim().length < 2 || find.isPending}>
                {find.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
                Find
              </Button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyRelevant} onCheckedChange={(c) => setOnlyRelevant(c === true)} aria-label="Only jobs matching my target roles" />
            Only jobs matching my target roles
          </label>
        </form>

        <div aria-live="polite" className="space-y-3">
          {find.isPending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Looking for {searched}&apos;s job board...
            </p>
          ) : find.error ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(find.error)}</AlertDescription>
            </Alert>
          ) : results && results.length === 0 ? (
            <Alert>
              <AlertDescription className="space-y-1">
                <p>
                  We could not find a public job board for <strong>{searched}</strong>. Many companies use Workday, Keka, Darwinbox or their own portal, which cannot be followed.
                </p>
                <p>
                  Create a job alert for this company on Naukri or LinkedIn instead - it works for every company.{" "}
                  <a href="#job-alerts" className="font-medium underline">
                    Set up job alerts
                  </a>
                </p>
              </AlertDescription>
            </Alert>
          ) : results ? (
            <ul className="grid gap-2 sm:grid-cols-2" aria-label="Job boards found">
              {results.map((b) => {
                const key = boardKey(b.provider, b.slug);
                const following = isFollowing(b.provider, b.slug);
                return (
                  <li key={key} className="flex flex-col gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="font-medium">{b.companyName ?? b.slug}</p>
                      <p className="text-xs text-muted-foreground">
                        {atsLabel(b.provider)} · {plural(b.jobCount, "open job")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a href={b.boardUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: "sm", variant: "ghost" }))}>
                        View board <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                      <Button
                        size="sm"
                        onClick={() => void follow({ provider: b.provider, slug: b.slug, companyName: b.companyName })}
                        disabled={following || pending.has(key) || atLimit}
                        aria-label={following ? `Following ${b.companyName ?? b.slug}` : `Follow ${b.companyName ?? b.slug}`}
                      >
                        {pending.has(key) ? <Loader2 className="animate-spin" aria-hidden="true" /> : following ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                        {following ? "Following" : "Follow"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        {suggestions.length ? (
          <section aria-labelledby={`${ids}-popular`} className="space-y-2">
            <h3 id={`${ids}-popular`} className="text-sm font-semibold">
              Popular in India
            </h3>
            <p className="text-xs text-muted-foreground">One click to follow. Job counts are a recent snapshot of openings in India.</p>
            <ul className="flex flex-wrap gap-2">
              {visible.map((c) => {
                const key = boardKey(c.provider, c.slug);
                const name = companyName(c);
                const jobs = companyJobs(c);
                return (
                  <li key={key}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full"
                      onClick={() => void follow({ provider: c.provider, slug: c.slug, companyName: name })}
                      disabled={pending.has(key) || atLimit}
                      aria-label={`Follow ${name}${jobs != null ? `, about ${jobs} jobs in India` : ""}`}
                    >
                      {pending.has(key) ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                      {name}
                      {jobs != null ? <span className="font-normal text-muted-foreground">· {jobs} in India</span> : null}
                    </Button>
                  </li>
                );
              })}
            </ul>
            {suggestions.length > SUGGESTED_VISIBLE ? (
              <Button variant="link" size="sm" className="px-0" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                {showAll ? "Show fewer" : `Show all ${suggestions.length} companies`}
              </Button>
            ) : null}
          </section>
        ) : null}

        {atLimit ? <p className="text-sm text-muted-foreground">You follow {limit} companies, the maximum. Remove one to follow another.</p> : null}
        <FeedList feeds={boards} title={boards.length ? `Following (${boards.length})` : undefined} />
      </CardContent>
    </Card>
  );
}
