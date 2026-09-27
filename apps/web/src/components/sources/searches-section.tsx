"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Check, Loader2, Plus, SearchCheck } from "lucide-react";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, Checkbox, Input, Label, NativeSelect, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { FeedView, JobFeedsOverview, SearchProviderView, SearchSuggestion } from "@/lib/client-types";
import { attributionOf, savedSearches, searchKey } from "./feed-utils";
import { FeedList } from "./feed-row";
import { useSourceCreated } from "./use-job-feeds";

export const INDIAN_CITIES = ["Bengaluru", "Hyderabad", "Pune", "Mumbai", "Chennai", "Delhi", "Gurugram", "Noida", "Kolkata", "Ahmedabad", "Kochi", "Jaipur", "Chandigarh", "Indore", "Coimbatore"];

export function createSearch(body: { provider: string; keywords: string; location: string | null; remoteOnly: boolean; maxDaysOld?: number }) {
  return api<FeedView>("/api/job-feeds/search", { body: { maxDaysOld: 7, ...body } });
}

export const suggestionKey = (s: SearchSuggestion) => `${s.provider}|${s.keywords.toLowerCase()}|${(s.location ?? "").toLowerCase()}|${s.remoteOnly}`;

export function coverageText(p: Pick<SearchProviderView, "coverage">): string {
  if (p.coverage === "india") return "Jobs in Indian cities";
  if (p.coverage === "remote") return "Remote jobs open to India";
  if (p.coverage === "global") return "Jobs worldwide";
  return String(p.coverage);
}

export function ProviderAttribution({ provider }: { provider: SearchProviderView | undefined }) {
  const a = provider ? attributionOf(provider.attribution) : null;
  if (!a) return null;
  return a.url ? (
    <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
      {a.text}
    </a>
  ) : (
    <span>{a.text}</span>
  );
}

/** Add several saved searches one after another; stops at the first "limit reached" style failure. */
export async function addSearches(list: SearchSuggestion[]): Promise<{ added: number; failed: string | null }> {
  let added = 0;
  for (const s of list) {
    try {
      await createSearch({ provider: s.provider, keywords: s.keywords, location: s.location, remoteOnly: s.remoteOnly });
      added++;
    } catch (e) {
      return { added, failed: errorMessage(e) };
    }
  }
  return { added, failed: null };
}

export function SearchesSection({ data }: { data: JobFeedsOverview }) {
  const ids = useId();
  const created = useSourceCreated();
  const providers = Array.isArray(data.searchProviders) ? data.searchProviders : [];
  const available = providers.filter((p) => p.available);
  const unavailable = providers.filter((p) => !p.available);
  const searches = data.feeds.filter((f) => f.kind === "SEARCH");
  const limit = data.limits?.SEARCH ?? 12;
  const atLimit = searches.length >= limit;
  const providerOf = (id: string) => providers.find((p) => p.id === id);

  const [pending, setPending] = useState<Set<string>>(new Set());
  // Hidden right away after adding, until the refreshed overview lists the saved search (then
  // data.feeds is the only truth, so a search removed later is suggested again).
  const [added, setAdded] = useState<Set<string>>(new Set());
  const saved = savedSearches(data.feeds);
  const [seenFeeds, setSeenFeeds] = useState(data.feeds);
  if (seenFeeds !== data.feeds) {
    setSeenFeeds(data.feeds);
    if ([...added].some((k) => saved.has(k))) setAdded(new Set([...added].filter((k) => !saved.has(k))));
  }
  const addedKey = (s: SearchSuggestion) => searchKey(s.provider, s.keywords, s.location);
  const suggestions = (Array.isArray(data.searchSuggestions) ? data.searchSuggestions : []).filter((s) => !added.has(addedKey(s)) && !saved.has(addedKey(s)));
  const [addingAll, setAddingAll] = useState(false);
  const [form, setForm] = useState({ provider: available[0]?.id ?? "", keywords: "", location: "", remoteOnly: false, maxDaysOld: "7" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const provider = providerOf(form.provider) ?? available[0];
  const forcedRemote = provider?.coverage === "remote";
  const remote = forcedRemote || form.remoteOnly;

  const addOne = async (s: SearchSuggestion) => {
    const key = suggestionKey(s);
    setPending((p) => new Set(p).add(key));
    try {
      await createSearch({ provider: s.provider, keywords: s.keywords, location: s.location, remoteOnly: s.remoteOnly });
      setAdded((a) => new Set(a).add(addedKey(s)));
      created(`Saved "${s.label}". Checking now - new jobs will appear in your inbox.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(key);
        return n;
      });
    }
  };

  const addAll = async () => {
    setAddingAll(true);
    const r = await addSearches(suggestions);
    setAdded((a) => new Set([...a, ...suggestions.slice(0, r.added).map(addedKey)]));
    setAddingAll(false);
    if (r.added) created(`Added ${r.added} saved search${r.added === 1 ? "" : "es"}. Checking now - new jobs will appear in your inbox.`);
    if (r.failed) toast.error(r.failed);
  };

  return (
    <Card id="saved-searches" className="scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <SearchCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold leading-tight tracking-tight">Saved searches</h2>
        </div>
        <CardDescription>ApplyWise searches job-search services for your target roles and cities twice a day.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!data.hasProfilePrefs ? (
          <p className="text-sm text-muted-foreground">
            Add your target roles and cities in your{" "}
            <Link href="/profile" className="font-medium text-foreground underline">
              profile
            </Link>{" "}
            to get one-click search suggestions here.
          </p>
        ) : null}

        {suggestions.length ? (
          <section aria-labelledby={`${ids}-sugg`} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${ids}-sugg`} className="text-sm font-semibold">
                Suggested for you
              </h3>
              <Button size="sm" onClick={() => void addAll()} disabled={addingAll || atLimit}>
                {addingAll ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                Add all suggested ({suggestions.length})
              </Button>
            </div>
            <ul className="flex flex-wrap gap-2">
              {suggestions.map((s) => {
                const key = suggestionKey(s);
                const p = providerOf(s.provider);
                return (
                  <li key={key}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full"
                      onClick={() => void addOne(s)}
                      disabled={pending.has(key) || addingAll || atLimit}
                      aria-label={`Add saved search ${s.label}${p ? ` on ${p.label}` : ""}`}
                    >
                      {pending.has(key) ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                      {s.label}
                      {p ? <span className="font-normal text-muted-foreground">· {p.label}</span> : null}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : data.hasProfilePrefs && searches.length > 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Check className="h-4 w-4" aria-hidden="true" /> All suggested searches are added.
          </p>
        ) : null}

        {available.length ? (
          <form
            className="space-y-3 rounded-md border p-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!provider || !form.keywords.trim()) return;
              setFormBusy(true);
              setFormError(null);
              try {
                await createSearch({
                  provider: provider.id,
                  keywords: form.keywords.trim(),
                  location: remote ? null : form.location.trim() || null,
                  remoteOnly: remote,
                  maxDaysOld: Number(form.maxDaysOld) || 7,
                });
                setForm((f) => ({ ...f, keywords: "", location: "" }));
                created();
              } catch (err) {
                setFormError(errorMessage(err));
              } finally {
                setFormBusy(false);
              }
            }}
          >
            <h3 className="text-sm font-semibold">Add your own search</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-provider`}>Search on</Label>
                <NativeSelect id={`${ids}-provider`} value={provider?.id ?? ""} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                  {available.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} - {coverageText(p)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-kw`}>Job title or keywords</Label>
                <Input id={`${ids}-kw`} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="e.g. React developer" maxLength={120} />
              </div>
              {!remote ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}-city`}>City</Label>
                  <Input id={`${ids}-city`} list={`${ids}-cities`} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="All of India" maxLength={120} />
                  <datalist id={`${ids}-cities`}>
                    {INDIAN_CITIES.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-days`}>Posted in the last</Label>
                <NativeSelect id={`${ids}-days`} value={form.maxDaysOld} onChange={(e) => setForm({ ...form, maxDaysOld: e.target.value })}>
                  <option value="1">1 day</option>
                  <option value="3">3 days</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                </NativeSelect>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={remote} disabled={forcedRemote} onCheckedChange={(c) => setForm({ ...form, remoteOnly: c === true })} aria-label="Remote only" />
                Remote only
                {forcedRemote ? <span className="text-xs text-muted-foreground">({provider?.label} lists remote jobs only)</span> : null}
              </label>
              <Button type="submit" disabled={formBusy || !form.keywords.trim() || atLimit}>
                {formBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />} Add search
              </Button>
            </div>
            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        ) : (
          <Alert variant="warning">
            <AlertDescription>No job-search service is available on this server yet. Job alerts and followed companies still work.</AlertDescription>
          </Alert>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Search services</p>
          <ul className="space-y-1">
            {available.map((p) => (
              <li key={p.id}>
                <span className="font-medium text-foreground">{p.label}</span> - {coverageText(p)}
                {p.descriptionLevel === "SNIPPET" ? " (short summaries)" : ""} · <ProviderAttribution provider={p} />
              </li>
            ))}
            {unavailable.map((p) => (
              <li key={p.id} className="opacity-75">
                <span className="font-medium">{p.label}</span> - {coverageText(p)} ·{" "}
                {data.operatorView && p.requiredEnv?.length ? `Not set up: needs ${p.requiredEnv.join(" and ")} in .env` : "Not available on this server yet"}
                {data.operatorView && p.signupUrl ? (
                  <>
                    {" "}
                    (free key:{" "}
                    <a href={p.signupUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      {p.signupUrl.replace(/^https?:\/\//, "")}
                    </a>
                    )
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        {atLimit ? <p className="text-sm text-muted-foreground">You have {limit} saved searches, the maximum. Remove one to add another.</p> : null}
        <FeedList feeds={searches} title={searches.length ? `Your saved searches (${searches.length})` : undefined} />
      </CardContent>
    </Card>
  );
}
