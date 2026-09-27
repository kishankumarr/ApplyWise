import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@applywise/database";
import { route } from "@/server/http";
import { extensionCorsHeaders } from "@/server/services/extension.service";

export const GET = route({ auth: "extension" }, async ({ userId }) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  return { signedIn: true, name: user?.name ?? null, email: user?.email ?? null };
});

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: extensionCorsHeaders(req) });
}
