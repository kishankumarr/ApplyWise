"use client";

import Link from "next/link";
import type { ProviderSourceCard } from "@applywise/types";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, Checkbox, cn, EmptyState, Skeleton } from "@applywise/ui";
import { errorMessage } from "@/lib/api";
import { CAPABILITY_STATUS_LABELS, capabilityVariant, FieldError, SectionHeading } from "./control-shared";
import type { FormApi } from "./settings-form";

export function SettingsProvidersSection({
  api,
  providers,
  loading,
  loadError,
  onRetry,
}: {
  api: FormApi;
  providers: ProviderSourceCard[] | undefined;
  loading: boolean;
  loadError: unknown;
  onRetry: () => void;
}) {
  const { form, set, error, disabled } = api;
  const all = form.providerScope === "all";
  const selected = new Set(form.enabledProviders);
  const list = providers ?? [];
  const scopeError = error("enabledProviders");

  const toggle = (id: string, on: boolean) => {
    if (all) {
      // Unticking one source while "all" is chosen switches to an explicit selection of every other source.
      if (on) return;
      set("providerScope", "selected");
      set(
        "enabledProviders",
        list.map((p) => p.id).filter((p) => p !== id),
      );
      return;
    }
    const next = on ? [...selected, id] : [...selected].filter((p) => p !== id);
    // Keep the server's order for a stable diff.
    set(
      "enabledProviders",
      list.map((p) => p.id).filter((p) => next.includes(p)).concat(next.filter((p) => !list.some((x) => x.id === p))),
    );
  };

  return (
    <Card role="region" aria-labelledby="providers-title">
      <SectionHeading
        id="providers-title"
        step={3}
        title="Enabled job sources"
        description={
          <>
            Which sources the automation uses. Capabilities are what this server supports today; set up and connect sources on the{" "}
            <Link href="/settings/job-sources" className="font-medium text-primary underline-offset-4 hover:underline">
              Job sources
            </Link>{" "}
            page.
          </>
        }
      />
      <CardContent className="space-y-4">
        <fieldset disabled={disabled} aria-describedby={scopeError ? "providers-error" : undefined}>
          <legend className="sr-only">Job sources used by the automation</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {(
              [
                { value: "all", label: "All job sources", note: "Including sources added later" },
                { value: "selected", label: "Only the sources I select", note: "Choose below" },
              ] as const
            ).map((o) => (
              <label
                key={o.value}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                  form.providerScope === o.value ? "border-primary bg-primary/5" : "hover:bg-accent/40",
                )}
              >
                <input
                  type="radio"
                  name="provider-scope"
                  value={o.value}
                  checked={form.providerScope === o.value}
                  onChange={() => {
                    set("providerScope", o.value);
                    // "All" is stored as an empty list; "selected" starts from every source so you can untick some.
                    if (o.value === "all") set("enabledProviders", []);
                    else if (form.enabledProviders.length === 0) set("enabledProviders", list.map((p) => p.id));
                  }}
                  className="h-4 w-4 accent-primary"
                />
                <span className="font-medium">{o.label}</span>
                <span className="text-xs text-muted-foreground">({o.note})</span>
              </label>
            ))}
          </div>
        </fieldset>
        <FieldError id="providers-error" message={scopeError} />

        {loading && !providers ? (
          <div className="grid gap-2 md:grid-cols-2" aria-busy="true" aria-label="Loading job sources">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : loadError && !providers ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              Could not load job sources: {errorMessage(loadError)}
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : list.length === 0 ? (
          <EmptyState title="No job sources on this server" description="An administrator has not configured any job sources yet." />
        ) : (
          <ul className="grid gap-2 md:grid-cols-2" aria-label="Job sources">
            {list.map((p) => {
              const checked = all || selected.has(p.id);
              const auto = p.capabilities.AUTO_APPLY;
              const discovery = p.capabilities.DISCOVERY;
              const id = `provider-${p.id}`;
              return (
                <li key={p.id}>
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex h-full cursor-pointer items-start gap-3 rounded-md border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                      checked ? "bg-background" : "bg-muted/30",
                      disabled && "cursor-not-allowed opacity-70",
                    )}
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={(c) => toggle(p.id, c === true)}
                      aria-labelledby={`${id}-label`}
                      aria-describedby={`${id}-caps ${id}-note`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span id={`${id}-label`} className="text-sm font-medium">
                          {p.label}
                        </span>
                        {p.demo ? <Badge variant="warning">DEMO CONTENT</Badge> : null}
                      </span>
                      <span id={`${id}-caps`} className="flex flex-wrap gap-1.5">
                        <Badge variant={capabilityVariant(auto.status)} className="font-medium">
                          Auto-apply: {CAPABILITY_STATUS_LABELS[auto.status]}
                        </Badge>
                        <Badge variant="outline" className="font-medium">
                          Discovery: {CAPABILITY_STATUS_LABELS[discovery.status]}
                        </Badge>
                      </span>
                      <span id={`${id}-note`} className="line-clamp-2 block text-xs text-muted-foreground">
                        {auto.note}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {!all && list.length ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => set("enabledProviders", list.map((p) => p.id))}>
              Select all
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => set("enabledProviders", [])}>
              Clear selection
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
