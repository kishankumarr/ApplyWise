import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// The monorepo keeps a single .env at the repository root.
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js requires inline scripts for hydration; 'unsafe-eval' only in dev for React Refresh.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self' mailto:",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@applywise/ui",
    "@applywise/types",
    "@applywise/validation",
    "@applywise/ai",
    "@applywise/job-engine",
    "@applywise/mail-sources",
    "@applywise/resume-engine",
    "@applywise/email",
    "@applywise/database",
  ],
  serverExternalPackages: ["@prisma/client", ".prisma/client", "pdfkit", "unpdf", "mammoth", "mailparser", "imapflow", "nodemailer", "bullmq", "ioredis", "docx", "playwright-core"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
