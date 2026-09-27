import { z } from "zod";
import { route } from "@/server/http";
import { resumeService } from "@/server/services/resume.service";

export const GET = route({}, async ({ userId }) => resumeService.listVersions(userId));

const snapshotSchema = z.object({ label: z.string().trim().min(1).max(120).default("Edited profile") });

/** Save the verified profile as a new resume version. */
export const POST = route({ body: snapshotSchema }, async ({ userId, body, requestId }) => resumeService.snapshotProfile(userId, body.label, requestId));
