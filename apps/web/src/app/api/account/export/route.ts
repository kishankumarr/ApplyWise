import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { accountService } from "@/server/services/account.service";

export const GET = route({}, async ({ userId, requestId }) => {
  const data = await accountService.export(userId, requestId);
  return new NextResponse(JSON.stringify({ success: true, data, requestId }, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="applywise-export.json"', "cache-control": "no-store" },
  });
});
