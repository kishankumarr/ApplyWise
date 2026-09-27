import { route } from "@/server/http";
import { dashboardService } from "@/server/services/dashboard.service";

export const GET = route({}, async ({ userId }) => dashboardService.summary(userId));
