import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";

export const metadata: Metadata = {
  title: { default: `${APP_NAME} - job application copilot`, template: `%s · ${APP_NAME}` },
  description: "India-focused, truthful AI-assisted job discovery and application copilot.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-screen antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
