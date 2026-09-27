import Link from "next/link";
import { Briefcase } from "lucide-react";
import { buttonVariants, cn } from "@applywise/ui";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Briefcase className="h-5 w-5 text-primary" aria-hidden="true" />
            {APP_NAME}
          </Link>
          <nav className="flex items-center gap-2 text-sm" aria-label="Public">
            <Link href="/privacy" className="px-2 text-muted-foreground hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="px-2 text-muted-foreground hover:text-foreground">
              Terms
            </Link>
            <Link href="/sign-in" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
              Sign in
            </Link>
            <Link href="/sign-up" className={cn(buttonVariants({ size: "sm" }))}>
              Get started
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        {APP_NAME} MVP · Final submission always stays with you · <Link href="/privacy" className="underline">Privacy</Link> ·{" "}
        <Link href="/terms" className="underline">Terms</Link>
      </footer>
    </div>
  );
}
