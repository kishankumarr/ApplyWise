import "server-only";
import bcrypt from "bcryptjs";
import { prisma } from "@applywise/database";
import type { SignUpInput } from "@applywise/validation";
import { audit } from "../audit";
import { Errors } from "../errors";
import { logger } from "../logger";
import { profileRepo } from "../repositories/profile.repo";
import { emailVerificationService } from "./email-verification.service";

export const authService = {
  async signUp(input: SignUpInput, requestId?: string): Promise<{ userId: string }> {
    const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    // The endpoint is rate limited to slow down account enumeration.
    if (existing) throw Errors.conflict("An account with this email already exists. Try signing in.");
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash }, select: { id: true } });
    await profileRepo.ensure(user.id);
    await audit(user.id, "auth.signed_up", { requestId });
    try {
      // Sent by a background task (never blocks sign-up); the link is never returned from this public endpoint.
      await emailVerificationService.queueInitial(user.id, requestId);
    } catch (e) {
      logger.warn("auth.signup.verification_email_failed", { requestId, error: e instanceof Error ? e.name : "unknown" });
    }
    return { userId: user.id };
  },
};
