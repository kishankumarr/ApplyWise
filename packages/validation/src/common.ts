import { z } from "zod";
import {
  APPLICATION_STATUSES,
  APPLY_METHODS,
  EMPLOYMENT_TYPES,
  FACT_KINDS,
  JOB_IMPORT_METHODS,
  JOB_PLATFORMS,
  JOB_WORK_MODES,
  QUESTION_TYPES,
  SENIORITY_LEVELS,
  SKILL_SOURCES,
  TRUTH_STATUSES,
  WORK_MODES,
} from "@applywise/types";

export const jobPlatformSchema = z.enum(JOB_PLATFORMS);
export const jobImportMethodSchema = z.enum(JOB_IMPORT_METHODS);
export const applyMethodSchema = z.enum(APPLY_METHODS);
export const applicationStatusSchema = z.enum(APPLICATION_STATUSES);
export const questionTypeSchema = z.enum(QUESTION_TYPES);
export const truthStatusSchema = z.enum(TRUTH_STATUSES);
export const workModePreferenceSchema = z.enum(WORK_MODES);
export const jobWorkModeSchema = z.enum(JOB_WORK_MODES);
export const employmentTypeSchema = z.enum(EMPLOYMENT_TYPES);
export const seniorityLevelSchema = z.enum(SENIORITY_LEVELS);
export const factKindSchema = z.enum(FACT_KINDS);
export const skillSourceSchema = z.enum(SKILL_SOURCES);

export const cuidSchema = z.string().min(1).max(64);

/** Accepts "", null or a valid http(s) URL; normalises empty strings to null. */
export const optionalUrlSchema = z
  .union([z.literal(""), z.null(), z.url({ protocol: /^https?$/ }).max(2048)])
  .optional()
  .transform((v) => (v ? v : null));

export const optionalEmailSchema = z
  .union([z.literal(""), z.null(), z.email().max(320)])
  .optional()
  .transform((v) => (v ? v.toLowerCase() : null));

export const trimmedString = (max: number) => z.string().trim().max(max);
export const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);

export const stringList = (maxItems: number, maxLen = 120) =>
  z.array(nonEmptyString(maxLen)).max(maxItems);
