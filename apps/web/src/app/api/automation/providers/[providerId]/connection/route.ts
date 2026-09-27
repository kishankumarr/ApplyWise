import { providerConnectSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { providerConnectionsService } from "@/server/services/provider-connections.service";

/** PUT: connect a provider with an API key / access token (encrypted; never returned). */
export const PUT = route<{ providerId: string }, typeof providerConnectSchema>({ body: providerConnectSchema }, async ({ userId, params, body, requestId }) =>
  providerConnectionsService.connect(userId, params.providerId, body, requestId),
);

export const DELETE = route<{ providerId: string }>({}, async ({ userId, params, requestId }) => providerConnectionsService.disconnect(userId, params.providerId, requestId));
