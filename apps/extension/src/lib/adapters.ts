import type { FieldDescriptor } from "./types";

/**
 * Career-page adapters: SAFE, user-triggered field mapping only. They recognise well-known
 * field names on ATS forms. They never read page data beyond labels, never upload files and
 * never interact with buttons.
 */
export interface SiteAdapter {
  id: "greenhouse" | "lever" | "workday" | "ashby" | "generic";
  matches(url: string): boolean;
  /** Prefill key -> predicate over field descriptors. */
  fields: Partial<Record<string, (f: FieldDescriptor) => boolean>>;
}

const byName = (...names: string[]) => (f: FieldDescriptor) => names.includes(f.name) || names.includes(f.id);
const byAutomationId = (...ids: string[]) => (f: FieldDescriptor) => ids.some((id) => f.automationId.includes(id));

export const greenhouseAdapter: SiteAdapter = {
  id: "greenhouse",
  matches: (url) => /greenhouse\.io|\/demo\/ats\/greenhouse\//.test(url),
  fields: {
    firstName: byName("first_name", "job_application[first_name]"),
    lastName: byName("last_name", "job_application[last_name]"),
    email: byName("email", "job_application[email]"),
    phone: byName("phone", "job_application[phone]"),
    location: byName("job_application[location]", "location"),
    coverLetter: byName("cover_letter_text", "cover_letter"),
  },
};

export const leverAdapter: SiteAdapter = {
  id: "lever",
  matches: (url) => /jobs\.lever\.co|\/demo\/ats\/lever\//.test(url),
  fields: {
    fullName: byName("name"),
    email: byName("email"),
    phone: byName("phone"),
    currentCompany: byName("org"),
    linkedin: byName("urls[LinkedIn]"),
    github: byName("urls[GitHub]"),
    portfolio: byName("urls[Portfolio]"),
    coverLetter: byName("comments"),
  },
};

export const workdayAdapter: SiteAdapter = {
  id: "workday",
  matches: (url) => /myworkdayjobs\.com|workday|\/demo\/ats\/workday\//.test(url),
  fields: {
    firstName: byAutomationId("legalNameSection_firstName"),
    lastName: byAutomationId("legalNameSection_lastName"),
    email: byAutomationId("email"),
    phone: byAutomationId("phone-number"),
  },
};

export const ashbyAdapter: SiteAdapter = {
  id: "ashby",
  matches: (url) => /ashbyhq\.com|\/demo\/ats\/ashby\//.test(url),
  fields: {
    fullName: byName("_systemfield_name"),
    email: byName("_systemfield_email"),
    phone: byName("_systemfield_phone"),
    linkedin: byName("_systemfield_linkedin"),
  },
};

export const genericAdapter: SiteAdapter = { id: "generic", matches: () => true, fields: {} };

export const ADAPTERS: SiteAdapter[] = [greenhouseAdapter, leverAdapter, workdayAdapter, ashbyAdapter];

export function adapterFor(url: string): SiteAdapter {
  return ADAPTERS.find((a) => a.matches(url)) ?? genericAdapter;
}
