"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface TokenRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export function ExtensionTokens() {
  const qc = useQueryClient();
  const [created, setCreated] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["ext-tokens"], queryFn: () => api<TokenRow[]>("/api/integrations/extension-tokens") });
  const create = useMutation({
    mutationFn: () => api<{ token: string }>("/api/integrations/extension-tokens", { body: { name: "Browser extension" } }),
    onSuccess: (r) => {
      setCreated(r.token);
      void qc.invalidateQueries({ queryKey: ["ext-tokens"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/integrations/extension-tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ext-tokens"] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Browser extension</CardTitle>
        <CardDescription>
          Connect the extension with a personal token. The extension only acts when you click: it imports the page you are viewing and prefills fields you select. It never submits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Button variant="outline" onClick={() => create.mutate()} disabled={create.isPending}>
          Create connection token
        </Button>
        {created ? (
          <Alert variant="info">
            <AlertDescription>
              Copy this token into the extension now - it is shown only once.
              <Input readOnly className="mt-2" value={created} onFocus={(e) => e.currentTarget.select()} aria-label="Extension token" />
            </AlertDescription>
          </Alert>
        ) : null}
        <ul className="divide-y">
          {data?.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                {t.name} · created {formatDateTime(t.createdAt)} · last used {formatDateTime(t.lastUsedAt)}
                {t.revokedAt ? " · revoked" : ` · expires ${formatDateTime(t.expiresAt)}`}
              </span>
              {!t.revokedAt ? (
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(t.id)}>
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
