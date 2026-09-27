import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __applywisePrisma?: PrismaClient };

/** Singleton Prisma client (survives Next.js dev hot reloads). Query logging is off: queries may contain PII. */
export const prisma: PrismaClient =
  globalForPrisma.__applywisePrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG_QUERIES === "true" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.__applywisePrisma = prisma;
