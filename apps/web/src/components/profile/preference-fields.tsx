"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { PREFERRED_LOCATION_OPTIONS, WORK_MODES, type WorkModePreference } from "@applywise/types";
import { NOTICE_PERIOD_OPTIONS } from "@applywise/validation";
import { Badge, Button, Checkbox, Input, Label, NativeSelect } from "@applywise/ui";

export function YoeField({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="max-w-xs space-y-2">
      <Label htmlFor="yoe">Total years of professional experience</Label>
      <Input
        id="yoe"
        type="number"
        min={0}
        max={60}
        step={0.5}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        aria-describedby="yoe-help"
      />
      <p id="yoe-help" className="text-xs text-muted-foreground">
        Use your real total. It is compared with each job&apos;s stated range.
      </p>
    </div>
  );
}

export function LocationsField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [custom, setCustom] = useState("");
  const toggle = (loc: string, on: boolean) => onChange(on ? [...new Set([...value, loc])] : value.filter((v) => v !== loc));
  const customOnes = value.filter((v) => !(PREFERRED_LOCATION_OPTIONS as readonly string[]).includes(v));
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Preferred locations</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PREFERRED_LOCATION_OPTIONS.map((loc) => (
          <label key={loc} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <Checkbox checked={value.includes(loc)} onCheckedChange={(c) => toggle(loc, c === true)} aria-label={loc} />
            {loc}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {customOnes.map((c) => (
          <Badge key={c} variant="secondary" className="gap-1">
            {c}
            <button type="button" aria-label={`Remove ${c}`} onClick={() => toggle(c, false)}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex max-w-md gap-2">
        <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Add a custom location, e.g. Noida" aria-label="Custom location" />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (custom.trim()) toggle(custom.trim(), true);
            setCustom("");
          }}
        >
          Add
        </Button>
      </div>
    </fieldset>
  );
}

export function WorkModeField({
  value,
  relocation,
  onChange,
  onRelocationChange,
}: {
  value: WorkModePreference;
  relocation: boolean;
  onChange: (v: WorkModePreference) => void;
  onRelocationChange: (v: boolean) => void;
}) {
  const labels: Record<WorkModePreference, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite", any: "Any" };
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Preferred work mode</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {WORK_MODES.map((m) => (
            <label key={m} className={`cursor-pointer rounded-md border px-4 py-2 text-sm ${value === m ? "border-primary bg-primary/10" : ""}`}>
              <input type="radio" name="workMode" value={m} checked={value === m} onChange={() => onChange(m)} className="sr-only" />
              {labels[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={relocation} onCheckedChange={(c) => onRelocationChange(c === true)} aria-label="Open to relocation" />
        I am open to relocating for the right role
      </label>
    </div>
  );
}

const ROLE_SUGGESTIONS = ["Frontend Engineer", "React Developer", "Full-Stack Developer", "Software Engineer", "UI Engineer", "Backend Engineer"];

export function RolesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = (r: string) => {
    const role = r.trim();
    if (role && !value.includes(role) && value.length < 10) onChange([...value, role]);
  };
  return (
    <div className="space-y-3">
      <Label htmlFor="role-input">Target roles</Label>
      <div className="flex flex-wrap gap-2">
        {value.map((r) => (
          <Badge key={r} className="gap-1">
            {r}
            <button type="button" aria-label={`Remove ${r}`} onClick={() => onChange(value.filter((x) => x !== r))}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex max-w-md gap-2">
        <Input
          id="role-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
              setInput("");
            }
          }}
          placeholder="e.g. Frontend Engineer"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            add(input);
            setInput("");
          }}
        >
          Add
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {ROLE_SUGGESTIONS.filter((s) => !value.includes(s)).map((s) => (
          <Button key={s} type="button" size="sm" variant="ghost" onClick={() => add(s)}>
            + {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function NoticeSalaryField({
  notice,
  salaryMin,
  salaryMax,
  onChange,
}: {
  notice: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  onChange: (v: { noticePeriod?: string | null; expectedSalaryMin?: number | null; expectedSalaryMax?: number | null }) => void;
}) {
  const toLpa = (v: number | null) => (v == null ? "" : String(v / 100000));
  const fromLpa = (s: string) => (s === "" ? null : Math.round(Number(s) * 100000));
  return (
    <div className="grid max-w-xl gap-4 sm:grid-cols-3">
      <div className="space-y-2">
        <Label htmlFor="notice">Notice period</Label>
        <NativeSelect id="notice" value={notice ?? ""} onChange={(e) => onChange({ noticePeriod: e.target.value || null })}>
          <option value="">Not specified</option>
          {NOTICE_PERIOD_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="salaryMin">Expected CTC min (LPA, optional)</Label>
        <Input id="salaryMin" type="number" min={0} step={0.5} value={toLpa(salaryMin)} onChange={(e) => onChange({ expectedSalaryMin: fromLpa(e.target.value) })} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="salaryMax">Expected CTC max (LPA, optional)</Label>
        <Input id="salaryMax" type="number" min={0} step={0.5} value={toLpa(salaryMax)} onChange={(e) => onChange({ expectedSalaryMax: fromLpa(e.target.value) })} />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-3">Salary is private and only mentioned in applications when a job asks for it and you approve the answer.</p>
    </div>
  );
}
