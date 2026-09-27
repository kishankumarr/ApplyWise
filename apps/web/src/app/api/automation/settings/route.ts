import { automationSettingsUpdateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { automationSettingsService } from "@/server/services/automation-settings.service";

/** GET: the Automation control centre (settings, rules, status, readiness). */
export const GET = route({}, async ({ userId }) => automationSettingsService.getView(userId));

/** PUT: update settings/rules; `autoApplyConsent` grants or revokes the AUTO_APPLY consent. */
export const PUT = route({ body: automationSettingsUpdateSchema }, async ({ userId, body, requestId }) => automationSettingsService.update(userId, body, requestId));
