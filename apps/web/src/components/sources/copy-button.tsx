"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, cn, toast, type ButtonProps } from "@applywise/ui";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure origins: fall back to a hidden textarea.
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copies `value`; the accessible name says what is copied ("Copy address"). */
export function CopyButton({ value, label = "Copy", what, className, variant = "outline", size = "sm" }: { value: string; label?: string; what?: string; className?: string; variant?: ButtonProps["variant"]; size?: ButtonProps["size"] }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn("shrink-0", className)}
      aria-label={what ? `Copy ${what}` : label}
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          toast.success(what ? `Copied ${what}.` : "Copied.");
        } else toast.error("Could not copy. Select the text and copy it manually.");
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {size === "icon" ? null : copied ? "Copied" : label}
    </Button>
  );
}
