"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signInSchema, signUpSchema, type SignInInput, type SignUpInput } from "@applywise/validation";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label } from "@applywise/ui";
import { api, ApiClientError } from "@/lib/api";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<SignInInput>({ resolver: zodResolver(signInSchema), defaultValues: { email: "", password: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const res = await signIn("credentials", { ...values, redirect: false });
    if (!res || res.error) {
      setError(res?.code === "rate_limited" ? "Too many attempts. Please wait a minute." : "Invalid email or password.");
      return;
    }
    router.push(params.get("callbackUrl") ?? "/dashboard");
    router.refresh();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Local demo account: <code>demo@applywise.test</code> / <code>DemoPass2026!</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" aria-invalid={!!form.formState.errors.email} aria-describedby="email-error" {...form.register("email")} />
            <FieldError id="email-error" message={form.formState.errors.email?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} aria-describedby="password-error" {...form.register("password")} />
            <FieldError id="password-error" message={form.formState.errors.password?.message} />
          </div>
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link href="/sign-up" className="underline">
              Create an account
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: "", email: "", password: "", acceptTerms: false as unknown as true },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api("/api/auth/signup", { body: values });
      const res = await signIn("credentials", { email: values.email, password: values.password, redirect: false });
      if (!res || res.error) throw new Error("Account created, but sign-in failed. Please sign in.");
      router.push("/onboarding");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError && e.fieldErrors) {
        for (const [k, msgs] of Object.entries(e.fieldErrors)) form.setError(k as keyof SignUpInput, { message: msgs[0] });
      }
      setError(e instanceof Error ? e.message : "Sign-up failed.");
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Your data stays private. You choose what gets processed.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input id="name" autoComplete="name" aria-invalid={!!form.formState.errors.name} {...form.register("name")} />
            <FieldError id="name-error" message={form.formState.errors.name?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
            <FieldError id="email-error" message={form.formState.errors.email?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!form.formState.errors.password} aria-describedby="password-help" {...form.register("password")} />
            <p id="password-help" className="text-xs text-muted-foreground">
              At least 10 characters with upper- and lower-case letters and a number.
            </p>
            <FieldError id="password-error" message={form.formState.errors.password?.message} />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="acceptTerms"
              checked={!!form.watch("acceptTerms")}
              onCheckedChange={(v) => form.setValue("acceptTerms", (v === true) as true, { shouldValidate: true })}
            />
            <Label htmlFor="acceptTerms" className="text-sm font-normal leading-5">
              I accept the <Link href="/terms" className="underline">terms</Link> and <Link href="/privacy" className="underline">privacy notice</Link>.
            </Label>
          </div>
          <FieldError id="terms-error" message={form.formState.errors.acceptTerms?.message} />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
