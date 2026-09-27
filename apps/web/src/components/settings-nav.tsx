import Link from "next/link";

export type SettingsTab = "account" | "privacy" | "integrations" | "job-sources" | "answers";

const ITEMS: readonly { key: SettingsTab; href: string; label: string }[] = [
  { key: "account", href: "/settings", label: "Account" },
  { key: "privacy", href: "/settings/privacy", label: "Privacy & consent" },
  { key: "integrations", href: "/settings/integrations", label: "Integrations" },
  { key: "job-sources", href: "/settings/job-sources", label: "Job sources" },
  { key: "answers", href: "/settings/answers", label: "Application answers" },
];

export function SettingsNav({ active }: { active: SettingsTab }) {
  return (
    // Scrolls sideways on narrow screens instead of wrapping; the inner row carries the underline.
    <nav aria-label="Settings" className="mb-6 overflow-x-auto">
      <div className="flex w-max min-w-full gap-2 border-b">
        {ITEMS.map((i) => (
          <Link
            key={i.key}
            href={i.href}
            aria-current={active === i.key ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${active === i.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {i.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
