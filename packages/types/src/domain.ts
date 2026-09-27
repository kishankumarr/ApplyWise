import type {
  ApplyMethod,
  EmploymentType,
  FactKind,
  JobImportMethod,
  JobPlatform,
  JobWorkMode,
  QuestionType,
  SeniorityLevel,
  SkillSource,
  TruthStatus,
  WorkModePreference,
} from "./enums";

export interface TruthBankItem {
  id: string;
  kind: FactKind;
  text: string;
  status: TruthStatus;
  /** Section of the CV the fact came from, if any. */
  section?: string | null;
  experienceId?: string | null;
  projectId?: string | null;
  educationId?: string | null;
}

export interface CandidateSkillFact {
  id: string;
  name: string;
  canonicalName: string;
  source: SkillSource;
  status: TruthStatus;
  yearsUsed?: number | null;
}

export interface ExperienceFact {
  id: string;
  title: string;
  company: string;
  location?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent: boolean;
  status: TruthStatus;
  bullets: TruthBankItem[];
}

export interface EducationFact {
  id: string;
  institution: string;
  degree?: string | null;
  field?: string | null;
  startYear?: number | null;
  endYear?: number | null;
  status: TruthStatus;
}

export interface ProjectFact {
  id: string;
  name: string;
  description: string;
  url?: string | null;
  technologies: string[];
  status: TruthStatus;
}

export interface CandidateProfile {
  id: string;
  userId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  yoe: number | null;
  preferredLocations: string[];
  workModePreference: WorkModePreference;
  openToRelocation: boolean;
  targetRoles: string[];
  noticePeriod: string | null;
  expectedSalaryMin: number | null;
  expectedSalaryMax: number | null;
  currentTitle: string | null;
  currentCompany: string | null;
  portfolioUrl: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
  summary: string | null;
  skills: CandidateSkillFact[];
  experience: ExperienceFact[];
  education: EducationFact[];
  projects: ProjectFact[];
  truthBankItems: TruthBankItem[];
}

export interface JobSkill {
  name: string;
  canonicalName: string;
  /** Mandatory requirements are penalised strongly when missing. */
  mandatory: boolean;
}

export interface JobOtherRequirement {
  text: string;
  mandatory: boolean;
}

export interface NormalizedJob {
  id?: string;
  platform: JobPlatform;
  title: string;
  company: string;
  companyWebsite: string | null;
  location: string[];
  workMode: JobWorkMode;
  employmentType: EmploymentType;
  seniority: SeniorityLevel;
  description: string;
  responsibilities: string[];
  requiredSkills: JobSkill[];
  preferredSkills: JobSkill[];
  /** Non-skill requirements, e.g. "Bachelor's degree", "Immediate joiner". */
  otherRequirements: JobOtherRequirement[];
  domains: string[];
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  postedAt: string | null;
  expiresAt: string | null;
  applyUrl: string | null;
  hrEmail: string | null;
  applicationInstructions: string | null;
  screeningQuestions: string[];
  applyMethod: ApplyMethod;
  importMethod: JobImportMethod;
  sourceUrl: string | null;
  sourceExternalId: string | null;
  isDemo?: boolean;
}

export type ScoreLabel = "low" | "moderate" | "strong";
export type ApplicationRecommendation = "apply" | "apply_with_caution" | "do_not_prioritize";

export type EvidenceLevel =
  | "experience"
  | "project"
  | "questionnaire"
  | "skills_section"
  | "unverified"
  | "none";

export interface MatchEvidence {
  requirement: string;
  canonicalName: string;
  matchType: "exact" | "related" | "unverified" | "missing";
  evidenceLevel: EvidenceLevel;
  /** Truth bank / skill fact ids that support this match. */
  sourceFactIds: string[];
  evidenceText: string[];
  relatedVia: string | null;
  mandatory: boolean;
  required: boolean;
}

export type ScoreFactorKey =
  | "required_skill_coverage"
  | "evidence_strength"
  | "role_seniority_alignment"
  | "domain_relevance"
  | "location_workmode_fit"
  | "resume_format"
  | "mandatory_gap_penalty";

export interface ScoreFactor {
  key: ScoreFactorKey;
  label: string;
  points: number;
  maxPoints: number;
  explanation: string;
}

export interface FitResult {
  fit: "good" | "partial" | "poor" | "unknown";
  explanation: string;
}

export interface JobMatchReport {
  estimatedMatchScore: number;
  scoreLabel: ScoreLabel;
  summary: string;
  exactMatches: MatchEvidence[];
  relatedMatches: MatchEvidence[];
  unverifiedMatches: MatchEvidence[];
  missingMandatoryRequirements: MatchEvidence[];
  missingPreferredRequirements: MatchEvidence[];
  scoreFactors: ScoreFactor[];
  resumeFormatWarnings: string[];
  locationFit: FitResult;
  yoeFit: FitResult;
  applicationRecommendation: ApplicationRecommendation;
  risks: string[];
  resumeImprovements: string[];
  engineVersion: string;
}

export interface QuestionOption {
  value: string;
  label: string;
}

export interface JobQuestion {
  id: string;
  type: QuestionType;
  text: string;
  whyAsked: string;
  requiredForJob: boolean;
  relatedRequirement: string | null;
  options: QuestionOption[] | null;
  allowFreeText: boolean;
  /** Only show this question when another answer matches one of the values. */
  showWhen: { questionId: string; equalsAny: string[] } | null;
}

export type QuestionnaireStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";

export interface QuestionAnswer {
  value: string;
  freeText?: string | null;
}

export interface JobQuestionnaire {
  jobId: string;
  questions: JobQuestion[];
  answers: Record<string, QuestionAnswer>;
  status: QuestionnaireStatus;
}

export interface SourcedClaim {
  text: string;
  sourceFactIds: string[];
}

export type ResumeSectionKey =
  | "summary"
  | "experience"
  | "projects"
  | "skills"
  | "education"
  | "achievements";

export interface TailoredBulletChange {
  experienceId: string | null;
  originalFactId: string | null;
  original: string | null;
  proposed: string;
  sourceFactIds: string[];
  rationale: string;
  confidence: "high" | "medium" | "low";
}

export interface TailoredResumePlan {
  summary: SourcedClaim;
  bulletChanges: TailoredBulletChange[];
  selectedSkills: { name: string; sourceFactIds: string[] }[];
  sectionOrder: ResumeSectionKey[];
  orderingNotes: string[];
  warnings: string[];
}

export type ClaimSeverity = "low" | "medium" | "high";

export interface ClaimValidationResult {
  validClaims: SourcedClaim[];
  unsupportedClaims: { claim: SourcedClaim; reason: string; severity: ClaimSeverity }[];
  mayShow: boolean;
  requiredRevisions: string[];
}

/** Allowed source fact passed to generators and the claim validator. */
export interface SourceFact {
  id: string;
  kind: FactKind;
  text: string;
}
