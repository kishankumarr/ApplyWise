import type { IntegrationClass, JobImportMethod, JobPlatform, NormalizedJob } from "@applywise/types";

/** A job as received from a source, before normalisation. Raw metadata is preserved verbatim. */
export interface RawImportedJob {
  provider: JobPlatform;
  importMethod: JobImportMethod;
  externalId: string | null;
  sourceUrl: string | null;
  /** Human-readable source attribution shown in the UI, e.g. "Forwarded Naukri alert". */
  attribution: string;
  /** Original source payload / metadata, stored unchanged on JobImportEvent.rawPayload. */
  raw: Record<string, unknown>;
  /** Job description text to normalise. */
  text: string;
  /** "SNIPPET" when only a short summary is available (alert emails, search-API snippets). Defaults to FULL. */
  descriptionLevel?: "FULL" | "SNIPPET";
  /** Explicitly provided structured fields (never guessed). */
  hints: Partial<Omit<NormalizedJob, "importMethod" | "location">> & {
    /** Array of locations or a comma/slash separated string. */
    location?: string[] | string;
    requiredSkillNames?: string[];
    preferredSkillNames?: string[];
  };
}

export interface ImportInput {
  /** Free-form payload; each connector validates what it needs. */
  payload: unknown;
  userId?: string;
}

export interface JobSourceConnector {
  provider: JobPlatform;
  importMethod: JobImportMethod;
  integrationClass: IntegrationClass;
  /** Short description displayed on /settings/integrations. */
  description: string;
  isConfigured(): boolean;
  importJobs(input: ImportInput): Promise<RawImportedJob[]>;
  normalize(raw: RawImportedJob): Promise<NormalizedJob>;
}

export class ConnectorNotConfiguredError extends Error {
  constructor(connector: string) {
    super(`Connector "${connector}" is not configured. It is disabled by default.`);
    this.name = "ConnectorNotConfiguredError";
  }
}

export class ConnectorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInputError";
  }
}
