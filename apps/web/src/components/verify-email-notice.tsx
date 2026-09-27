"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MailWarning } from "lucide-react";
import { Alert, AlertDescription, AlertTitle, Button, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";

export type VerificationDelivery = "outbox" | "catcher" | "external";

interface SendResult {
  sent: boolean;
  alreadyVerified: boolean;
  delivery: VerificationDelivery;
  devVerificationUrl?: string;
}

/**
 * Shown while the account email is unconfirmed. Sending application emails requires confirmation.
 * The copy depends on where mail actually goes, so it never claims a link was delivered when it was not.
 */
export function VerifyEmailNotice({
  email,
  delivery,
  devLinkAvailable,
  compact = false,
}: {
  email: string;
  delivery: VerificationDelivery;
  devLinkAvailable: boolean;
  compact?: boolean;
}) {
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () => api<SendResult>("/api/account/verification", { body: {} }),
    onSuccess: (r) => {
      if (r.alreadyVerified) {
        toast.success("Your email is already confirmed.");
        window.location.reload();
        return;
      }
      if (r.delivery === "external") toast.success(`Confirmation link sent to ${email}.`);
      else if (r.delivery === "catcher") toast.success("Confirmation link sent to the test mail server (not a real inbox).");
      else toast.info("Email delivery is not configured, so the link was not emailed.");
      if (r.devVerificationUrl) setDevUrl(r.devVerificationUrl);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canRequest = delivery !== "outbox" || devLinkAvailable;
  return (
    <Alert variant="warning" data-testid="verify-email-notice" className={compact ? "" : "mb-4"}>
      <MailWarning className="h-4 w-4" />
      <AlertTitle>Confirm your email address</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {delivery === "external" ? (
            <>
              We sent a confirmation link to <strong>{email}</strong>.
            </>
          ) : delivery === "catcher" ? (
            <>
              A confirmation link for <strong>{email}</strong> was sent to this server&apos;s test mail server (for example Mailpit); it is not
              delivered to a real inbox.
            </>
          ) : (
            <>
              Email delivery is not configured on this server, so no confirmation link can be emailed to <strong>{email}</strong>.
              {!devLinkAvailable ? " Ask the administrator to configure an email provider." : null}
            </>
          )}{" "}
          You need to confirm your address before ApplyWise can send application emails for you (it is used as your reply-to address).
        </p>
        {canRequest ? (
          <Button size="sm" variant="outline" onClick={() => resend.mutate()} disabled={resend.isPending}>
            {delivery === "outbox" ? "Get a confirmation link" : "Resend confirmation email"}
          </Button>
        ) : null}
        {devUrl ? (
          <p className="text-xs">
            Development only:{" "}
            <a href={devUrl} className="underline" data-testid="dev-verification-link">
              open the confirmation link
            </a>
            .
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
