import { Suspense } from "react";
import { PublicShell } from "@/components/public-shell";
import { SignInForm } from "@/components/auth-forms";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-md px-4 py-16">
        <Suspense>
          <SignInForm />
        </Suspense>
      </div>
    </PublicShell>
  );
}
