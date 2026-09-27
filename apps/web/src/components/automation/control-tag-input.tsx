"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge, Input, Label } from "@applywise/ui";

/**
 * A simple tag input: type and press Enter or a comma (pasting a comma/line separated list also works).
 * Backspace in the empty input removes the last tag. Text left in the box is added when it loses focus.
 */
export function ControlTagInput({
  id,
  label,
  hint,
  value,
  onChange,
  maxItems,
  maxLength,
  placeholder,
  error,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string[];
  onChange: (next: string[]) => void;
  maxItems: number;
  maxLength: number;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const full = value.length >= maxItems;

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,\n;]/)
      .map((s) => s.trim().slice(0, maxLength))
      .filter(Boolean);
    setText("");
    if (!parts.length) return;
    const seen = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    const added: string[] = [];
    for (const p of parts) {
      if (next.length >= maxItems) break;
      if (seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      next.push(p);
      added.push(p);
    }
    if (added.length) {
      onChange(next);
      setAnnouncement(`Added ${added.join(", ")}.`);
    } else if (next.length >= maxItems) {
      setAnnouncement(`You can add at most ${maxItems}.`);
    }
  };

  const remove = (tag: string) => {
    onChange(value.filter((v) => v !== tag));
    setAnnouncement(`Removed ${tag}.`);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // Enter adds a tag instead of submitting the settings form.
      e.preventDefault();
      commit(text);
    } else if (e.key === "Backspace" && text === "" && value.length) {
      e.preventDefault();
      remove(value[value.length - 1]!);
    }
  };

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hintId, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label} (${value.length})`}>
          {value.map((tag) => (
            <li key={tag}>
              <Badge variant="secondary" className="gap-1 py-1 pl-2.5 pr-1 font-medium">
                <span className="max-w-[16rem] truncate">{tag}</span>
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  disabled={disabled}
                  aria-label={`Remove ${tag}`}
                  className="rounded-full p-0.5 hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        ref={inputRef}
        id={id}
        value={text}
        disabled={disabled}
        maxLength={maxLength * 4}
        placeholder={full ? `Maximum of ${maxItems} reached` : placeholder}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,\n;]/.test(v)) commit(v);
          else setText(v);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (text.trim()) commit(text);
        }}
        autoComplete="off"
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint ? `${hint} ` : ""}
        {full ? `You have reached the maximum of ${maxItems}.` : "Press Enter or type a comma to add. Leave empty for no filter."}
      </p>
      {error ? (
        <p id={errorId} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
