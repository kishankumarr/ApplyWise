import "server-only";
import { prisma } from "@applywise/database";

export type SelectedResumeRef = { selectedResumeVersionId: string | null; selectedResume: { label: string | null; originalFileName: string } | null };

/**
 * Display labels of the selected resumes. A selection is either an uploaded file (Resume) or a labelled resume
 * version without a file (e.g. "Full-stack Resume"): the latter's label lives on the ResumeVersion.
 */
export async function selectedResumeLabels(userId: string, apps: SelectedResumeRef[]): Promise<(string | null)[]> {
  const versionIds = [...new Set(apps.filter((a) => !a.selectedResume && a.selectedResumeVersionId).map((a) => a.selectedResumeVersionId!))];
  const versions = versionIds.length ? await prisma.resumeVersion.findMany({ where: { id: { in: versionIds }, userId }, select: { id: true, label: true } }) : [];
  const byId = new Map(versions.map((v) => [v.id, v.label]));
  return apps.map((a) => a.selectedResume?.label ?? a.selectedResume?.originalFileName ?? (a.selectedResumeVersionId ? (byId.get(a.selectedResumeVersionId) ?? null) : null));
}
