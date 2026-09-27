"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Bot, Briefcase, ClipboardList, Database, FileText, Gauge, ListChecks, LogOut, Radar, Search, Settings, User } from "lucide-react";
import { Button, cn } from "@applywise/ui";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/automation", label: "Automation", icon: Bot },
  { href: "/jobs", label: "Jobs", icon: Search },
  { href: "/review", label: "Review", icon: ListChecks },
  { href: "/jobs/sources", label: "Job sources", icon: Radar },
  { href: "/applications", label: "Applications", icon: ClipboardList },
  { href: "/resume", label: "Resume", icon: FileText },
  { href: "/profile", label: "Profile", icon: User },
  { href: "/settings", label: "Settings", icon: Settings },
];

const matches = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

export function AppNav({ userName, showAdmin }: { userName: string; showAdmin: boolean }) {
  const pathname = usePathname();
  const links = showAdmin ? [...LINKS, { href: "/admin/demo-data", label: "Demo data", icon: Database }] : LINKS;
  // Only the most specific matching link is active: /jobs/sources highlights "Job sources", not "Jobs";
  // /automation/runs/... highlights "Automation".
  const activeHref = links.filter((l) => matches(pathname, l.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <aside className="border-b bg-muted/30 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between px-4 py-4">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <Briefcase className="h-5 w-5 text-primary" aria-hidden="true" />
          {APP_NAME}
        </Link>
      </div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
        {links.map((l) => {
          const active = l.href === activeHref;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <l.icon className="h-4 w-4" aria-hidden="true" />
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 pb-4 md:absolute md:bottom-0 md:w-60 md:py-4">
        <p className="truncate text-xs text-muted-foreground" title={userName}>
          Signed in as {userName}
        </p>
        <Button variant="ghost" size="sm" className="mt-2 px-0" onClick={() => signOut({ callbackUrl: "/" })}>
          <LogOut aria-hidden="true" /> Sign out
        </Button>
      </div>
    </aside>
  );
}
