import { route } from "@/server/http";
import { resumeService } from "@/server/services/resume.service";

export const GET = route<{ versionId: string }>({}, async ({ userId, params }) => resumeService.getVersion(userId, params.versionId));
