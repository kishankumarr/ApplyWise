import { z } from "zod";

export const matchEvidenceSchema = z.object({
  requirement: z.string(),
  canonicalName: z.string(),
  matchType: z.enum(["exact", "related", "unverified", "missing"]),
  evidenceLevel: z.enum([
    "experience",
    "project",
    "questionnaire",
    "skills_section",
    "unverified",
    "none",
  ]),
  sourceFactIds: z.array(z.string()),
  evidenceText: z.array(z.string()),
  relatedVia: z.string().nullable(),
  mandatory: z.boolean(),
  required: z.boolean(),
});

export const scoreFactorSchema = z.object({
  key: z.enum([
    "required_skill_coverage",
    "evidence_strength",
    "role_seniority_alignment",
    "domain_relevance",
    "location_workmode_fit",
    "resume_format",
    "mandatory_gap_penalty",
  ]),
  label: z.string(),
  points: z.number(),
  maxPoints: z.number(),
  explanation: z.string(),
});

const fitSchema = z.object({
  fit: z.enum(["good", "partial", "poor", "unknown"]),
  explanation: z.string(),
});

export const jobMatchReportSchema = z.object({
  estimatedMatchScore: z.number().min(0).max(100),
  scoreLabel: z.enum(["low", "moderate", "strong"]),
  summary: z.string(),
  exactMatches: z.array(matchEvidenceSchema),
  relatedMatches: z.array(matchEvidenceSchema),
  unverifiedMatches: z.array(matchEvidenceSchema),
  missingMandatoryRequirements: z.array(matchEvidenceSchema),
  missingPreferredRequirements: z.array(matchEvidenceSchema),
  scoreFactors: z.array(scoreFactorSchema),
  resumeFormatWarnings: z.array(z.string()),
  locationFit: fitSchema,
  yoeFit: fitSchema,
  applicationRecommendation: z.enum(["apply", "apply_with_caution", "do_not_prioritize"]),
  risks: z.array(z.string()),
  resumeImprovements: z.array(z.string()),
  engineVersion: z.string(),
});
