import "server-only";
import { candidateInclude, loadCandidate, prisma, type CandidateRecord } from "@applywise/database";
import { Errors } from "../errors";

export const profileRepo = {
  async get(userId: string): Promise<CandidateRecord | null> {
    return loadCandidate(prisma, userId);
  },

  /** Get or create the (empty) profile + preferences for a user. */
  async ensure(userId: string): Promise<CandidateRecord> {
    const existing = await loadCandidate(prisma, userId);
    if (existing) return existing;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user) throw Errors.unauthenticated();
    return prisma.candidateProfile.create({
      data: {
        userId,
        fullName: user.name,
        email: user.email,
        preference: { create: { userId } },
      },
      include: candidateInclude,
    });
  },

  async bumpFactsVersion(userId: string): Promise<void> {
    await prisma.candidateProfile.update({ where: { userId }, data: { factsVersion: { increment: 1 } } });
  },

  /** Truth-bank fact, scoped to the user. */
  async getFact(userId: string, factId: string) {
    const fact = await prisma.truthBankItem.findFirst({ where: { id: factId, userId } });
    if (!fact) throw Errors.notFound("Fact");
    return fact;
  },
};
