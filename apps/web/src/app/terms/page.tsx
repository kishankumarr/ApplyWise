import { PublicShell } from "@/components/public-shell";

export const metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <PublicShell>
      <article className="mx-auto max-w-3xl space-y-4 px-4 py-12 text-sm leading-6">
        <h1 className="text-3xl font-bold">Terms of use</h1>
        <p className="text-muted-foreground">MVP terms - replace with reviewed terms before production.</p>
        <ol className="list-decimal space-y-2 pl-6">
          <li>You are responsible for the accuracy of everything you submit to employers. Review all generated content; AI output can be wrong.</li>
          <li>You must not use the service to misrepresent your experience, skills, qualifications or identity.</li>
          <li>You will use each job platform in line with its own terms. The service does not automate submissions or access job platforms with your credentials.</li>
          <li>Jobs found automatically come from official job-board and job-search APIs and from job-alert emails in a mailbox you choose to connect. They are shown only to you, with credit to their source, and may be incomplete or out of date - check the original posting before applying.</li>
          <li>The match score is a transparent heuristic. It does not guarantee ATS selection, an interview, or an offer.</li>
          <li>Demo jobs and demo accounts are fictional and provided for evaluation only.</li>
        </ol>
      </article>
    </PublicShell>
  );
}
