"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { CapabilityStatus } from "@applywise/types";
import { Checkbox, cn, Label } from "@applywise/ui";

// ---------------------------------------------------------------- query keys

export const SETTINGS_URL = "/api/automation/settings";
export const PROVIDERS_URL = "/api/automation/providers";
export const SETTINGS_KEY = ["automation", "settings"] as const;
export const PROVIDERS_KEY = ["automation", "providers"] as const;

/** Query-key heads (prefix match) whose data an automation run or a settings change can alter, on any page. */
const RELATED_PREFIXES = ["automation", "dashboard", "review", "job", "application", "notification", "consents"];

export function invalidateAutomationData(qc: QueryClient): void {
  void qc.invalidateQueries({
    predicate: (q) => {
      const head = q.queryKey[0];
      return typeof head === "string" && RELATED_PREFIXES.some((p) => head.startsWith(p));
    },
  });
}

// ---------------------------------------------------------------- provider capabilities

export const CAPABILITY_STATUS_LABELS: Record<CapabilityStatus, string> = {
  AVAILABLE: "Available",
  LIMITED: "Limited",
  NOT_CONFIGURED: "Not configured on this server",
  SUPPORTED: "Supported",
  EXPERIMENTAL: "Experimental",
  MANUAL: "Manual - you apply",
  EXTERNAL_LIMITATION: "Not possible (provider restriction)",
  REQUIRES_EXTERNAL_CONFIGURATION: "Needs external setup",
  NOT_SUPPORTED: "Not supported",
};

/** Automatic submission is only ever presented as possible for these statuses. */
export const canAutoSubmit = (s: CapabilityStatus) => s === "SUPPORTED" || s === "EXPERIMENTAL";

export function capabilityVariant(s: CapabilityStatus): "success" | "warning" | "info" | "secondary" | "outline" {
  if (s === "SUPPORTED") return "success";
  if (s === "EXPERIMENTAL") return "warning";
  if (s === "AVAILABLE") return "info";
  if (s === "LIMITED" || s === "MANUAL") return "secondary";
  return "outline";
}

// ---------------------------------------------------------------- search frequency

export const SEARCH_FREQUENCIES = [15, 30, 60, 180, 360, 720, 1440] as const;

export function frequencyLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ---------------------------------------------------------------- hooks

/** Re-render every `ms` so relative times ("5 min ago") stay current. */
export function useTick(ms = 30_000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// ---------------------------------------------------------------- small components

/** Relative time rendered on the server and the client (minute boundaries can differ, so no hydration warning). */
export function TimeText({ iso, children }: { iso: string | null; children: ReactNode }) {
  return (
    <time dateTime={iso ?? undefined} suppressHydrationWarning title={iso ? new Date(iso).toLocaleString("en-IN") : undefined}>
      {children}
    </time>
  );
}

/** Accessible on/off switch (role="switch"); labelled by an element id. */
export function ControlSwitch({
  id,
  checked,
  onCheckedChange,
  disabled,
  labelledBy,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("pointer-events-none block h-6 w-6 rounded-full bg-background shadow ring-0 transition-transform", checked ? "translate-x-5" : "translate-x-0")}
      />
    </button>
  );
}

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** Label + control + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) })}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs font-medium text-destructive">
      {message}
    </p>
  );
}

/** A labelled checkbox row with a description (same look as Settings -> Privacy). */
export function ToggleRow({
  id,
  checked,
  onChange,
  title,
  description,
  disabled,
  className,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
        disabled && "cursor-not-allowed opacity-70",
        className,
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(c) => onChange(c === true)}
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="mt-0.5"
      />
      <span className="text-sm">
        <span id={`${id}-title`} className="font-medium">
          {title}
        </span>
        {description ? (
          <span id={`${id}-desc`} className="mt-0.5 block text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** Section card heading used by every settings block (an h3 under the "Settings" h2). */
export function SectionHeading({ id, title, description, step }: { id: string; title: string; description?: ReactNode; step?: number }) {
  return (
    <div className="space-y-1.5 p-5">
      <h3 id={id} className="flex items-center gap-2 text-lg font-semibold leading-none tracking-tight">
        {step != null ? (
          <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {step}
          </span>
        ) : null}
        {title}
      </h3>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** Space-separated element ids for aria-describedby (undefined when none). */
export function joinIds(...ids: (string | false | null | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}
