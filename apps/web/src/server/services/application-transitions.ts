import "server-only";
import { prisma, type ApplicationStatus, type Prisma } from "@applywise/database";
import { InvalidTransitionError, nextStatus, type ApplicationAction } from "../domain/application-state";
import { Errors } from "../errors";

export type TransitionActor = "user" | "system" | "policy" | "executor";

export interface TransitionOptions {
  to?: ApplicationStatus;
  message: string;
  data?: Prisma.ApplicationUncheckedUpdateManyInput;
  metadata?: Record<string, unknown>;
  tx?: Prisma.TransactionClient;
  actor?: TransitionActor;
  /** Only transition when the application is currently in one of these statuses (else InvalidState). */
  from?: ApplicationStatus[];
  /** Extra compare-and-set conditions (e.g. the approval the caller acted on must still be the current one). */
  expect?: Prisma.ApplicationWhereInput;
}

/**
 * Atomic status transition (compare-and-set): the update only applies if the status is still the one the
 * transition was computed from, so two workers can never both move the same application (e.g. both start
 * APPROVED -> APPLYING). The ApplicationEvent is written with the same client (same transaction when `tx` is given).
 */
export async function transitionApplication(userId: string, applicationId: string, action: ApplicationAction, opts: TransitionOptions): Promise<ApplicationStatus> {
  const db = opts.tx ?? prisma;
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await db.application.findFirst({ where: { id: applicationId, userId }, select: { status: true } });
    if (!app) throw Errors.notFound("Application");
    if (opts.from && !opts.from.includes(app.status)) throw Errors.invalidState(`Application is ${app.status.replace(/_/g, " ").toLowerCase()}.`);
    let to: ApplicationStatus;
    try {
      to = nextStatus(app.status, action, opts.to);
    } catch (e) {
      if (e instanceof InvalidTransitionError) throw Errors.invalidState(e.message);
      throw e;
    }
    const res = await db.application.updateMany({ where: { ...opts.expect, id: applicationId, userId, status: app.status }, data: { ...opts.data, status: to } });
    if (res.count === 0) continue; // changed concurrently: re-read once and re-validate
    await db.applicationEvent.create({
      data: {
        applicationId,
        userId,
        type: action,
        fromStatus: app.status,
        toStatus: to,
        message: opts.message.slice(0, 500),
        actor: opts.actor ?? "user",
        metadata: (opts.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    return to;
  }
  throw Errors.conflict("The application was changed by another process. Please retry.");
}

/** Record a timeline entry without a status change (e.g. "resume selected", "daily limit reached"). */
export async function recordApplicationEvent(
  userId: string,
  applicationId: string,
  type: string,
  message: string,
  opts: { metadata?: Record<string, unknown>; actor?: TransitionActor; tx?: Prisma.TransactionClient } = {},
): Promise<void> {
  const db = opts.tx ?? prisma;
  await db.applicationEvent.create({
    data: { applicationId, userId, type, message: message.slice(0, 500), actor: opts.actor ?? "system", metadata: (opts.metadata ?? {}) as Prisma.InputJsonValue },
  });
}
