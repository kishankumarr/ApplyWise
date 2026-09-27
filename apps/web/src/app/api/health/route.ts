import { prisma } from "@applywise/database";
import { route } from "@/server/http";

export const GET = route({ auth: "public" }, async () => {
  await prisma.$queryRawUnsafe("SELECT 1");
  return { ok: true };
});
