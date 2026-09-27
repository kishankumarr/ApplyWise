import { route } from "@/server/http";
import { jobSourcesService } from "@/server/services/job-sources.service";

/** GET: one card per provider with its capability status on this server and the user's connection (no secrets). */
export const GET = route({}, async ({ userId }) => jobSourcesService.cards(userId));
