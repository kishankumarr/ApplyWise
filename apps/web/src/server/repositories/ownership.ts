import { Errors } from "../errors";

/**
 * Ownership enforcement. Repositories always filter by userId in the query itself; this
 * helper is the second line of defence and gives a uniform 404 (never leaks existence).
 */
export function assertOwned<T extends { userId: string } | null | undefined>(record: T, userId: string, what = "Resource"): NonNullable<T> {
  if (!record || record.userId !== userId) throw Errors.notFound(what);
  return record as NonNullable<T>;
}

/** Jobs are visible if shared (catalogue) or owned by the user. */
export function jobVisibleTo(userId: string) {
  return { OR: [{ ownerUserId: null }, { ownerUserId: userId }] };
}
