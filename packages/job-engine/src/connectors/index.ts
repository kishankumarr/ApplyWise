import { browserImportConnector } from "./browser";
import { csvImportConnector } from "./csv";
import { forwardedEmailConnector } from "./email";
import { careerPageUrlConnector, manualEntryConnector, pastedDescriptionConnector } from "./manual";
import { seededDemoConnector } from "./seeded";
import {
  apiKeyFeedConnector,
  greenhouseBoardApiConnector,
  leverPostingsApiConnector,
  officialPartnerApiConnector,
} from "./stubs";
import type { JobSourceConnector } from "./types";

export * from "./types";
export * from "./normalize";
export * from "./manual";
export * from "./csv";
export * from "./email";
export * from "./browser";
export * from "./seeded";
export * from "./stubs";

export const CONNECTORS = {
  manual: manualEntryConnector,
  paste: pastedDescriptionConnector,
  careerPageUrl: careerPageUrlConnector,
  csv: csvImportConnector,
  email: forwardedEmailConnector,
  browser: browserImportConnector,
  seeded: seededDemoConnector,
  officialPartnerApi: officialPartnerApiConnector,
  apiKeyFeed: apiKeyFeedConnector,
  greenhouseBoardApi: greenhouseBoardApiConnector,
  leverPostingsApi: leverPostingsApiConnector,
} satisfies Record<string, JobSourceConnector>;

export type ConnectorKey = keyof typeof CONNECTORS;

export function listConnectors(): { key: ConnectorKey; connector: JobSourceConnector; configured: boolean }[] {
  return (Object.keys(CONNECTORS) as ConnectorKey[]).map((key) => ({
    key,
    connector: CONNECTORS[key],
    configured: CONNECTORS[key].isConfigured(),
  }));
}
