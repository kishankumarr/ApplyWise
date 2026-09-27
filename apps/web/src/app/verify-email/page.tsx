import Link from "next/link";
import { XCircle } from "lucide-react";
import { buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@applywise/ui";
import { ConfirmEmailCard } from "@/components/confirm-email-card";
import { PublicShell } from "@/components/public-shell";
import { AppError } from "@/server/errors";
import { emailVerificationService } from "@/server/services/email-verification.service";

export const metadata = { title: "Confirm email" };
export const dynamic = "force-dynamic";

/**
 * Public: opened from the verification email (possibly in another browser). Rendering this page
 * never changes anything - the user confirms with a button (POST), so link scanners that open
 * URLs automatically cannot confirm an address.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let state: { ok: true; email: string; alreadyVerified: boolean } | { ok: false; message: string };
  if (!token) {
    state = { ok: false, message: "This link is missing its verification token." };
  } else {
    try {
      state = { ok: true, ...(await emailVerificationService.inspect(token)) };
    } catch (e) {
      state = { ok: false, message: e instanceof AppError ? e.message : "Verification failed. Please request a new link." };
    }
  }
  return (
    <PublicShell>
      <div className="mx-auto max-w-md px-4 py-16">
        {state.ok ? (
          <ConfirmEmailCard token={token!} email={state.email} alreadyVerified={state.alreadyVerified} />
        ) : (
          <Card data-testid="verify-email-result">
            <CardHeader>
              <XCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
              <CardTitle>Could not confirm your email</CardTitle>
              <CardDescription>{state.message}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/settings" className={cn(buttonVariants())}>
                Open settings to resend
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </PublicShell>
  );
}
