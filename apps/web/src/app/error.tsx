"use client";

import { useEffect } from "react";
import { Button } from "@applywise/ui";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Error-reporting hook: only the digest is reported from the client (no PII).
    console.error("ui.error", error.digest ?? "no-digest");
  }, [error]);
  return (
    <div className="mx-auto max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">The error was logged{error.digest ? ` (reference ${error.digest})` : ""}. Your data is safe.</p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
