"use client";

import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { profileUpdateSchema } from "@applywise/validation";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Textarea, toast } from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import { useProfile } from "@/lib/hooks";
import { PageHeader } from "../page-header";
import { FactsReview } from "./facts-review";
import { LocationsField, NoticeSalaryField, RolesField, WorkModeField, YoeField } from "./preference-fields";

type FormValues = z.input<typeof profileUpdateSchema>;

export function ProfileEditor() {
  const qc = useQueryClient();
  const { data: view, isLoading } = useProfile();
  const form = useForm<FormValues>({ resolver: zodResolver(profileUpdateSchema) });

  useEffect(() => {
    if (!view) return;
    const p = view.profile;
    form.reset({
      fullName: p.fullName ?? "",
      email: p.email ?? "",
      phone: p.phone ?? "",
      yoe: p.yoe,
      preferredLocations: p.preferredLocations,
      workModePreference: p.workModePreference,
      openToRelocation: p.openToRelocation,
      targetRoles: p.targetRoles,
      noticePeriod: p.noticePeriod,
      expectedSalaryMin: p.expectedSalaryMin,
      expectedSalaryMax: p.expectedSalaryMax,
      currentTitle: p.currentTitle ?? "",
      currentCompany: p.currentCompany ?? "",
      portfolioUrl: p.portfolioUrl ?? "",
      githubUrl: p.githubUrl ?? "",
      linkedinUrl: p.linkedinUrl ?? "",
      summary: p.summary ?? "",
    });
  }, [view, form]);

  const save = useMutation({
    mutationFn: (values: FormValues) => api("/api/profile", { method: "PATCH", body: values }),
    onSuccess: () => {
      toast.success("Profile saved. Match scores will refresh.");
      void qc.invalidateQueries({ queryKey: ["profile"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => {
      if (e instanceof ApiClientError && e.fieldErrors) {
        for (const [k, msgs] of Object.entries(e.fieldErrors)) form.setError(k as keyof FormValues, { message: msgs[0] });
      }
      toast.error(errorMessage(e));
    },
  });

  if (isLoading || !view) return <Skeleton className="h-96 w-full" />;
  const err = (k: keyof FormValues) => form.formState.errors[k]?.message as string | undefined;

  return (
    <div className="space-y-6">
      <PageHeader title="Profile" description="Your structured, verified profile. Only verified facts are used in matching evidence and generated content." />
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-6" noValidate>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact & current role</CardTitle>
            <CardDescription>User-entered details are treated as verified.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["fullName", "Full name"],
                ["email", "Email"],
                ["phone", "Phone"],
                ["currentTitle", "Current title"],
                ["currentCompany", "Current company"],
                ["linkedinUrl", "LinkedIn URL"],
                ["githubUrl", "GitHub URL"],
                ["portfolioUrl", "Portfolio URL"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`p-${k}`}>{label}</Label>
                <Input id={`p-${k}`} aria-invalid={!!err(k)} {...form.register(k)} />
                {err(k) ? <p className="text-sm text-destructive">{err(k)}</p> : null}
              </div>
            ))}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="p-summary">Profile summary</Label>
              <Textarea id="p-summary" rows={3} {...form.register("summary")} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Job preferences</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <Controller control={form.control} name="yoe" render={({ field }) => <YoeField value={(field.value as number | null) ?? null} onChange={field.onChange} />} />
            <Controller control={form.control} name="preferredLocations" render={({ field }) => <LocationsField value={field.value ?? []} onChange={field.onChange} />} />
            <Controller
              control={form.control}
              name="workModePreference"
              render={({ field }) => (
                <WorkModeField
                  value={field.value ?? "any"}
                  onChange={field.onChange}
                  relocation={!!form.watch("openToRelocation")}
                  onRelocationChange={(v) => form.setValue("openToRelocation", v, { shouldDirty: true })}
                />
              )}
            />
            <Controller control={form.control} name="targetRoles" render={({ field }) => <RolesField value={field.value ?? []} onChange={field.onChange} />} />
            <NoticeSalaryField
              notice={form.watch("noticePeriod") ?? null}
              salaryMin={(form.watch("expectedSalaryMin") as number | null) ?? null}
              salaryMax={(form.watch("expectedSalaryMax") as number | null) ?? null}
              onChange={(p) => {
                for (const [k, v] of Object.entries(p)) form.setValue(k as keyof FormValues, v as never, { shouldDirty: true });
              }}
            />
            {err("expectedSalaryMin") ? <p className="text-sm text-destructive">{err("expectedSalaryMin")}</p> : null}
          </CardContent>
        </Card>
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            Save profile
          </Button>
        </div>
      </form>
      <FactsReview view={view} />
    </div>
  );
}
