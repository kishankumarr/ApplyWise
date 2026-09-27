"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2 } from "lucide-react";
import type { WorkModePreference } from "@applywise/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Progress,
  Skeleton,
  toast,
} from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import { useProfile } from "@/lib/hooks";
import { FactsReview } from "./profile/facts-review";
import { FindJobsStep } from "./sources/onboarding-find-jobs";
import { LocationsField, NoticeSalaryField, RolesField, WorkModeField, YoeField } from "./profile/preference-fields";

const STEPS = [
  "Consent",
  "Upload CV",
  "Parse",
  "Verify facts",
  "Experience",
  "Locations",
  "Work mode",
  "Target roles",
  "Notice & salary",
  "Find jobs",
  "Finish",
] as const;

/** Step indices used by the navigation below (preferences are saved when leaving steps 4-8). */
const FIND_JOBS_STEP = 9;
const FINISH_STEP = 10;

interface Prefs {
  yoe: number | null;
  preferredLocations: string[];
  workModePreference: WorkModePreference;
  openToRelocation: boolean;
  targetRoles: string[];
  noticePeriod: string | null;
  expectedSalaryMin: number | null;
  expectedSalaryMax: number | null;
}

export function OnboardingWizard({ maxUploadMb, aiLabel, aiExternal }: { maxUploadMb: number; aiLabel: string; aiExternal: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [polling, setPolling] = useState(false);
  const { data: view, isLoading } = useProfile({ poll: polling });
  const [consent, setConsent] = useState({ cvProcessing: false, aiProcessing: false });
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [jobSources, setJobSources] = useState<number | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    if (!view || initialised.current) return;
    initialised.current = true;
    setConsent({ cvProcessing: view.consents.cvProcessing, aiProcessing: view.consents.aiProcessing });
    setPrefs({
      yoe: view.profile.yoe,
      preferredLocations: view.profile.preferredLocations,
      workModePreference: view.profile.workModePreference,
      openToRelocation: view.profile.openToRelocation,
      targetRoles: view.profile.targetRoles,
      noticePeriod: view.profile.noticePeriod,
      expectedSalaryMin: view.profile.expectedSalaryMin,
      expectedSalaryMax: view.profile.expectedSalaryMax,
    });
  }, [view]);

  // Keep parsed YOE in sync once parsing finishes (only if the user has not typed one).
  useEffect(() => {
    if (view && prefs && prefs.yoe == null && view.profile.yoe != null) setPrefs({ ...prefs, yoe: view.profile.yoe });
  }, [view, prefs]);

  const latestResume = view?.resumes[0];
  useEffect(() => {
    if (polling && latestResume && (latestResume.status === "PARSED" || latestResume.status === "FAILED")) setPolling(false);
  }, [polling, latestResume]);

  const saveConsent = useMutation({
    mutationFn: () => api("/api/consents", { method: "PATCH", body: consent }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profile"] });
      setStep(1);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a PDF or DOCX file first.");
      const fd = new FormData();
      fd.set("file", file);
      const resume = await api<{ id: string }>("/api/profile/resume/upload", { formData: fd });
      await api(`/api/profile/resume/${resume.id}/parse`, { body: {} });
      return resume;
    },
    onSuccess: () => {
      setPolling(true);
      void qc.invalidateQueries({ queryKey: ["profile"] });
      setStep(2);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const savePrefs = useMutation({
    mutationFn: (extra: { onboardingCompleted?: boolean } = {}) => api("/api/profile", { method: "PATCH", body: { ...prefs, ...extra } }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading || !view || !prefs) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const next = async () => {
    if (step >= 4 && step <= 8) await savePrefs.mutateAsync({});
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));
  const set = (patch: Partial<Prefs>) => setPrefs({ ...prefs, ...patch });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Set up your profile</h1>
        <p className="text-sm text-muted-foreground">
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </p>
        <Progress value={((step + 1) / STEPS.length) * 100} className="mt-3" aria-label="Onboarding progress" />
      </div>

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Consent for CV and AI processing</CardTitle>
            <CardDescription>You can change these any time in Settings → Privacy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-start gap-3 text-sm">
              <Checkbox checked={consent.cvProcessing} onCheckedChange={(c) => setConsent({ ...consent, cvProcessing: c === true })} aria-label="Consent to CV processing" />
              <span>
                <strong>CV processing (required)</strong> - store my CV encrypted and extract a structured profile from it so I can review it.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Checkbox checked={consent.aiProcessing} onCheckedChange={(c) => setConsent({ ...consent, aiProcessing: c === true })} aria-label="Consent to AI processing" />
              <span>
                <strong>AI processing (optional)</strong> - use {aiLabel} to improve parsing and drafts.{" "}
                {aiExternal ? "Relevant CV and job text is sent to this provider." : "Your data is not sent to a third party."} Without it, only on-server rules are used.
              </span>
            </label>
            <div className="flex justify-end">
              <Button onClick={() => saveConsent.mutate()} disabled={!consent.cvProcessing || saveConsent.isPending}>
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Upload your CV</CardTitle>
            <CardDescription>PDF or DOCX, up to {maxUploadMb} MB. Files are scanned, encrypted and never shared publicly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label htmlFor="cv-file" className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-sm hover:bg-accent/40">
              <FileUp className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
              <span>{file ? file.name : "Choose a file"}</span>
              <input
                id="cv-file"
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back}>
                Back
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(4)}>
                  Skip - enter details manually
                </Button>
                <Button onClick={() => upload.mutate()} disabled={!file || upload.isPending}>
                  {upload.isPending ? "Uploading…" : "Upload and parse"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Parsing your CV</CardTitle>
            <CardDescription>We extract facts and mark every one as “unverified” until you confirm it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!latestResume || latestResume.status === "PARSING" || latestResume.status === "UPLOADED" ? (
              <p className="flex items-center gap-2 text-sm" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Extracting text and structuring your profile…
              </p>
            ) : latestResume.status === "FAILED" ? (
              <Alert variant="destructive">
                <AlertTitle>Parsing failed</AlertTitle>
                <AlertDescription>{latestResume.parseError ?? "Please try another file or enter details manually."}</AlertDescription>
              </Alert>
            ) : (
              <Alert variant="info">
                <AlertTitle>Parsed {latestResume.originalFileName}</AlertTitle>
                <AlertDescription>
                  Found {view.profile.experience.length} roles, {view.profile.skills.length} skills and {view.profile.projects.length} projects
                  {latestResume.parserProvider === "fallback" ? " (rule-based parser)" : latestResume.parserProvider === "claude" ? " (Claude)" : " (local AI model)"}.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button onClick={() => setStep(3)} disabled={latestResume?.status !== "PARSED" && latestResume?.status !== "FAILED"}>
                Review facts
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <FactsReview view={view} />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
            <Button onClick={next}>Continue</Button>
          </div>
        </div>
      ) : null}

      {step >= 4 && step <= 8 ? (
        <Card>
          <CardHeader>
            <CardTitle>{STEPS[step]}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {step === 4 ? <YoeField value={prefs.yoe} onChange={(yoe) => set({ yoe })} /> : null}
            {step === 5 ? <LocationsField value={prefs.preferredLocations} onChange={(preferredLocations) => set({ preferredLocations })} /> : null}
            {step === 6 ? (
              <WorkModeField
                value={prefs.workModePreference}
                relocation={prefs.openToRelocation}
                onChange={(workModePreference) => set({ workModePreference })}
                onRelocationChange={(openToRelocation) => set({ openToRelocation })}
              />
            ) : null}
            {step === 7 ? <RolesField value={prefs.targetRoles} onChange={(targetRoles) => set({ targetRoles })} /> : null}
            {step === 8 ? (
              <NoticeSalaryField notice={prefs.noticePeriod} salaryMin={prefs.expectedSalaryMin} salaryMax={prefs.expectedSalaryMax} onChange={(p) => set(p)} />
            ) : null}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back}>
                Back
              </Button>
              <Button onClick={next} disabled={savePrefs.isPending || (step === 5 && prefs.preferredLocations.length === 0)}>
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === FIND_JOBS_STEP ? <FindJobsStep
          onBack={back}
          onDone={(n) => {
            setJobSources(n);
            setStep(FINISH_STEP);
          }}
        /> : null}

      {step === FINISH_STEP ? (
        <Card>
          <CardHeader>
            <CardTitle>You&apos;re all set</CardTitle>
            <CardDescription>
              {view.verification.unverified > 0
                ? `${view.verification.unverified} facts are still unverified - they will not be used as evidence until you confirm them.`
                : "All parsed facts are reviewed."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="list-disc pl-5">
              <li>Experience: {prefs.yoe ?? "not set"} years</li>
              <li>Locations: {prefs.preferredLocations.join(", ") || "not set"}</li>
              <li>Work mode: {prefs.workModePreference}{prefs.openToRelocation ? " · open to relocation" : ""}</li>
              <li>Target roles: {prefs.targetRoles.join(", ") || "not set"}</li>
              {jobSources != null ? (
                <li>
                  Job sources: {jobSources > 0 ? `${jobSources} set up - new jobs will arrive in your inbox automatically` : "none yet - add them any time under Job sources"}
                </li>
              ) : null}
            </ul>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back}>
                Back
              </Button>
              <Button
                onClick={async () => {
                  await savePrefs.mutateAsync({ onboardingCompleted: true });
                  router.push("/dashboard");
                  router.refresh();
                }}
                disabled={savePrefs.isPending}
              >
                Finish and go to dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <p className="text-xs text-muted-foreground">Tip: you can edit everything later in Profile.</p>
    </div>
  );
}
