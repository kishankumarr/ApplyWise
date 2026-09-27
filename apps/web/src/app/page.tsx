import Link from "next/link";
import { CheckCircle2, FileSearch, MailCheck, ShieldCheck, Sparkles, Target } from "lucide-react";
import { buttonVariants, Card, CardContent, CardHeader, CardTitle, cn } from "@applywise/ui";
import { PublicShell } from "@/components/public-shell";

const features = [
  { icon: FileSearch, title: "CV to verified profile", body: "Upload a PDF or DOCX. Every parsed fact stays “unverified” until you confirm it." },
  { icon: Target, title: "Transparent match score", body: "An estimated resume-to-job match with every point explained. No black box, no ATS promises." },
  { icon: Sparkles, title: "Truthful tailoring", body: "Tailored summaries, bullets and cover letters that cite your own facts - never invented metrics or skills." },
  { icon: MailCheck, title: "You stay in control", body: "Open official apply pages, prefill only what you approve, and review every email before it is sent." },
  { icon: ShieldCheck, title: "Compliant sources", body: "Official APIs, partner feeds, forwarded alerts, CSV, manual entry and user-triggered browser import. No scraping." },
  { icon: CheckCircle2, title: "One application tracker", body: "From saved to offer, with a full audit trail of drafts, edits and actions." },
];

export default function LandingPage() {
  return (
    <PublicShell>
      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
        <p className="text-sm font-medium text-primary">For job seekers in India</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          Apply smarter to jobs in Bengaluru, Hyderabad, Pune and remote India - truthfully.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
          One inbox for jobs from career pages, job-alert emails and manual imports. Ranked against your verified profile, with
          honest tailoring and application help. You always click the final submit.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/sign-up" className={cn(buttonVariants({ size: "lg" }))}>
            Create a free account
          </Link>
          <Link href="/sign-in" className={cn(buttonVariants({ size: "lg", variant: "outline" }))}>
            Try the demo account
          </Link>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-20 sm:grid-cols-2 lg:grid-cols-3" aria-label="Features">
        {features.map((f) => (
          <Card key={f.title}>
            <CardHeader>
              <f.icon className="h-6 w-6 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">{f.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{f.body}</CardContent>
          </Card>
        ))}
      </section>
    </PublicShell>
  );
}
