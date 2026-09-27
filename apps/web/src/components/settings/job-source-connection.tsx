"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ProviderSourceCard } from "@applywise/types";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, timeAgo, timeUntil } from "@/lib/format";
import { CONNECTION_STATUS } from "./job-source-labels";
import { AUTOMATION_SETTINGS_KEY, PROVIDERS_KEY } from "./job-source-queries";

/**
 * Account connection for providers that officially offer an API key / access token. The token is sent once,
 * encrypted on the server and never returned: after saving, only the masked account label is shown.
 */
export function JobSourceConnection({ card }: { card: ProviderSourceCard }) {
  const qc = useQueryClient();
  const ids = useId();
  const connection = card.connection;
  const connected = connection?.status === "CONNECTED";
  const [formOpen, setFormOpen] = useState(false);
  const [token, setToken] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const showForm = formOpen || !connected;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    void qc.invalidateQueries({ queryKey: AUTOMATION_SETTINGS_KEY });
  };

  const connect = useMutation({
    mutationFn: () =>
      api(`/api/automation/providers/${encodeURIComponent(card.id)}/connection`, {
        method: "PUT",
        body: { token: token.trim(), accountLabel: accountLabel.trim() || null },
      }),
    onSuccess: () => {
      // The token is never shown again - not even in this form.
      setToken("");
      setAccountLabel("");
      setFormError(null);
      setFormOpen(false);
      toast.success(`${card.label} connected. The token is stored encrypted and will not be shown again.`);
      refresh();
    },
    onError: (e) => {
      setFormError(errorMessage(e));
      toast.error(errorMessage(e));
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api(`/api/automation/providers/${encodeURIComponent(card.id)}/connection`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmDisconnect(false);
      toast.success(`${card.label} disconnected. The saved token was deleted.`);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const status = CONNECTION_STATUS[connection?.status ?? "NONE"];
  const expired = connection?.expiresAt ? new Date(connection.expiresAt).getTime() <= Date.now() : false;
  const tokenId = `${ids}-token`;
  const labelId = `${ids}-label`;
  const headingId = `${ids}-heading`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.trim().length < 4) {
      setFormError("Paste the API key or access token (at least 4 characters).");
      return;
    }
    setFormError(null);
    connect.mutate();
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md border bg-muted/30 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={headingId} className="font-medium">
          Account connection
        </h4>
        <Badge variant={status.tone} data-testid="connection-status">
          {status.label}
        </Badge>
      </div>

      {connection ? (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          {connection.accountLabel ? (
            <>
              <dt className="text-muted-foreground">Account</dt>
              <dd>{connection.accountLabel}</dd>
            </>
          ) : null}
          {connection.expiresAt ? (
            <>
              <dt className="text-muted-foreground">{expired ? "Expired" : "Expires"}</dt>
              <dd className={expired ? "font-medium text-destructive" : undefined}>
                {formatDateTime(connection.expiresAt)}
                {!expired ? <span className="text-muted-foreground"> ({timeUntil(connection.expiresAt)})</span> : null}
              </dd>
            </>
          ) : null}
          {connection.lastCheckedAt ? (
            <>
              <dt className="text-muted-foreground">Last checked</dt>
              <dd>{timeAgo(connection.lastCheckedAt)}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {card.cardStatus === "NEEDS_AUTHENTICATION"
            ? `Connect ${card.label} so the automation can submit applications through it.`
            : `Not connected. Connect ${card.label} with an API key or access token it issued to you.`}
        </p>
      )}

      {connection?.lastError ? (
        <p className="flex items-start gap-1.5 text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{connection.lastError}</span>
        </p>
      ) : null}

      {showForm ? (
        <form onSubmit={submit} className="space-y-3" aria-describedby={`${ids}-privacy`} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={tokenId}>{card.auth === "oauth_token" ? "Access token" : "API key or access token"}</Label>
            <Input
              id={tokenId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              minLength={4}
              maxLength={4000}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? `${ids}-error` : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={labelId}>
              Account label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id={labelId} autoComplete="off" maxLength={120} value={accountLabel} onChange={(e) => setAccountLabel(e.target.value)} aria-describedby={`${labelId}-hint`} />
            <p id={`${labelId}-hint`} className="text-xs text-muted-foreground">
              Helps you recognise this connection. Email addresses are shown masked (for example ka***@example.com).
            </p>
          </div>
          <p id={`${ids}-privacy`} className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            The token is encrypted on the server, never shown again and never logged. Job-platform passwords are never stored.
          </p>
          <div aria-live="polite">
            {formError ? (
              <p id={`${ids}-error`} className="text-destructive">
                {formError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={connect.isPending}>
              {connect.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
              {connection ? "Save new token" : "Connect"}
            </Button>
            {connected ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFormOpen(false);
                  setToken("");
                  setAccountLabel("");
                  setFormError(null);
                }}
                disabled={connect.isPending}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {connection ? (
        <div className="flex flex-wrap gap-2">
          {connected && !formOpen ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setFormOpen(true)} aria-label={`Replace token for ${card.label}`}>
              Replace token
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDisconnect(true)}
            aria-label={`Disconnect ${card.label}`}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      <Dialog open={confirmDisconnect} onOpenChange={(o) => !disconnect.isPending && setConfirmDisconnect(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {card.label}?</DialogTitle>
            <DialogDescription>
              The saved token is deleted. Applications that need this connection will wait for you or be handed over to you until you connect again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)} disabled={disconnect.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              {disconnect.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
