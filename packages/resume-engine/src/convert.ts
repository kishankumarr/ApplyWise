import { DEFAULT_SECTION_ORDER, type ParsedCv, type ResumeDocument } from "./types";

export function parsedCvToDocument(cv: ParsedCv): ResumeDocument {
  return {
    contact: {
      fullName: cv.fullName ?? "Your Name",
      email: cv.email,
      phone: cv.phone,
      location: cv.location,
      links: [cv.links.linkedin, cv.links.github, cv.links.portfolio, ...cv.links.other].filter((l): l is string => !!l),
    },
    headline: cv.headline,
    summary: cv.summary,
    experience: cv.experience.map((e) => ({
      title: e.title,
      company: e.company,
      location: e.location,
      startDate: e.startDate,
      endDate: e.isCurrent ? null : e.endDate,
      bullets: e.bullets,
    })),
    projects: cv.projects,
    skills: cv.skills,
    education: cv.education,
    achievements: [...cv.achievements, ...cv.certifications],
    sectionOrder: DEFAULT_SECTION_ORDER,
  };
}
