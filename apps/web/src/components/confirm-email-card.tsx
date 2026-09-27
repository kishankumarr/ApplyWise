"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Loader2, MailCheck, XCircle } from "lucide-react";
import { Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";

/** Confirmation step of the email-verification link: the address is confirmed only on this explicit POST. */
export function ConfirmEmailCard({ token, email, alreadyVerified }: { token: string; email: string; alreadyVerified: boolean }) {
  const [done, setDone] = useState(alreadyVerified);
  const confirm = useMutation({
    mutationFn: () => api<{ email: string }>("/api/account/verification/confirm", { body: { token } }),
    onSuccess: () => setDone(true),
  });
  if (done) {
    return (
      <Card data-testid="verify-email-result">
        <CardHeader>
          <CheckCircle2 className="h-8 w-8 text-emerald-600" aria-hidden="true" />
          <CardTitle>Email address confirmed</CardTitle>
          <CardDescription>{email} is confirmed. You can now send application emails from ApplyWise after reviewing them.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/dashboard" className={cn(buttonVariants())}>
            Go to dashboard
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (confirm.isError) {
    return (
      <Card data-testid="verify-email-result">
        <CardHeader>
          <XCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
          <CardTitle>Could not confirm your email</CardTitle>
          <CardDescription>{errorMessage(confirm.error)}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/settings" className={cn(buttonVariants())}>
            Open settings to resend
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="verify-email-confirm">
      <CardHeader>
        <MailCheck className="h-8 w-8 text-primary" aria-hidden="true" />
        <CardTitle>Confirm your email address</CardTitle>
        <CardDescription>
          Confirm that <strong>{email}</strong> is your address. It will be used as the reply-to address of application emails you send.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={() => confirm.mutate()} disabled={confirm.isPending} data-testid="confirm-email">
          {confirm.isPending ? <Loader2 className="animate-spin" /> : null} Confirm {email}
        </Button>
      </CardContent>
    </Card>
  );
}
