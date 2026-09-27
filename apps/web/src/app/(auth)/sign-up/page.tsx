import { PublicShell } from "@/components/public-shell";
import { SignUpForm } from "@/components/auth-forms";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-md px-4 py-16">
        <SignUpForm />
      </div>
    </PublicShell>
  );
}
