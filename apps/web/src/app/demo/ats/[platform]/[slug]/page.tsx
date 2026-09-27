import { notFound } from "next/navigation";
import { DEMO_JOBS, DEMO_SINGAPORE_PERMIT_QUESTION, DEMO_WORK_AUTH_QUESTION, demoAutomationJobBySlug } from "@applywise/job-engine";
import { env } from "@/env";
import { DemoAtsForm, DemoAtsLogin, type DemoScreeningQuestion } from "@/components/demo-ats-form";

export const metadata = { title: "Demo career page" };

const PLATFORMS: Record<string, string> = { greenhouse: "Greenhouse-like", lever: "Lever-like", workday: "Workday-like", ashby: "Ashby-like", career: "Company career page" };

type DemoVariant = "captcha" | "login" | null;

interface DemoPageJob {
  title: string;
  company: string;
  locations: string[];
  screening: DemoScreeningQuestion[];
  variant: DemoVariant;
}

/** The demo provider marks these questions required (yes/no); the page asks them the same way. */
const REQUIRED_YES_NO = new Set([DEMO_WORK_AUTH_QUESTION, DEMO_SINGAPORE_PERMIT_QUESTION]);

function parseVariant(value: string | null | undefined): DemoVariant {
  if (value === "captcha") return "captcha";
  if (value === "login") return "login";
  return null;
}

function findJob(slug: string): DemoPageJob | null {
  const classic = DEMO_JOBS.find((j) => j.key === slug);
  if (classic) return { title: classic.title, company: classic.company, locations: classic.locations, screening: classic.screening ?? [], variant: null };
  const auto = demoAutomationJobBySlug(slug, { appUrl: env().APP_URL });
  if (!auto) return null;
  return {
    title: auto.title,
    company: auto.company,
    locations: auto.locations,
    screening: auto.screening.map((q) => (REQUIRED_YES_NO.has(q) ? { question: q, required: true, options: ["Yes", "No"] } : q)),
    variant: parseVariant(auto.variant),
  };
}

/**
 * DEMO CONTENT: a fictional, local "official apply page" used to exercise the open-official-page flow, the
 * extension's user-triggered prefill and the worker-side browser executor. Nothing is sent anywhere.
 * ?variant=captcha shows a fake CAPTCHA box and ?variant=login a sign-in wall; both end in a manual handoff.
 */
export default async function DemoAtsPage({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { platform, slug } = await params;
  const query = await searchParams;
  const job = PLATFORMS[platform] ? findJob(slug) : null;
  if (!job) notFound();
  const variant = parseVariant(typeof query.variant === "string" ? query.variant : null) ?? job.variant;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        DEMO CONTENT - fictional {PLATFORMS[platform]} application page for local development. Submitting only shows a demo confirmation; nothing is sent anywhere.
      </p>
      <h1 className="mt-6 text-2xl font-bold">{job.title}</h1>
      <p className="text-muted-foreground">
        {job.company} · {job.locations.join(", ")}
      </p>
      {variant === "login" ? <DemoAtsLogin platform={platform} /> : <DemoAtsForm platform={platform} screening={job.screening} variant={variant === "captcha" ? "captcha" : null} />}
    </div>
  );
}
