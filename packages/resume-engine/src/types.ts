import type { ResumeSectionKey } from "@applywise/types";

/** Output of CV parsing (rule-based or Claude). Every item is PARSED_UNVERIFIED until the user confirms. */
export interface ParsedCv {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  links: { portfolio: string | null; github: string | null; linkedin: string | null; other: string[] };
  totalYearsExperience: number | null;
  experience: {
    title: string;
    company: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    bullets: string[];
  }[];
  education: {
    institution: string;
    degree: string | null;
    field: string | null;
    startYear: number | null;
    endYear: number | null;
  }[];
  projects: { name: string; description: string; technologies: string[]; url: string | null }[];
  skills: string[];
  certifications: string[];
  achievements: string[];
}

/** Renderable resume document (original, edited, or tailored version). */
export interface ResumeDocument {
  contact: {
    fullName: string;
    email: string | null;
    phone: string | null;
    location: string | null;
    links: string[];
  };
  headline: string | null;
  summary: string | null;
  experience: {
    title: string;
    company: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    bullets: string[];
  }[];
  projects: { name: string; description: string; technologies: string[]; url: string | null }[];
  skills: string[];
  education: { institution: string; degree: string | null; field: string | null; startYear: number | null; endYear: number | null }[];
  achievements: string[];
  sectionOrder: ResumeSectionKey[];
}

export const DEFAULT_SECTION_ORDER: ResumeSectionKey[] = [
  "summary",
  "experience",
  "projects",
  "skills",
  "education",
  "achievements",
];

export const SECTION_TITLES: Record<ResumeSectionKey, string> = {
  summary: "Profile Summary",
  experience: "Experience",
  projects: "Projects",
  skills: "Skills",
  education: "Education",
  achievements: "Achievements",
};
