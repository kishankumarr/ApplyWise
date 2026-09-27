/** Review queue paging, shared by the server page and the client queue (no client-only imports here). */

/** Full review cards, so pages are small (the API default too). */
export const REVIEW_PAGE_SIZE = 10;

/** `?page=` (1-based); anything else is page 1. The API accepts up to 10 000. */
export function reviewPageParam(raw: string | string[] | null | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

/** The address of one queue page (page 1 is plain /review). */
export const reviewPageHref = (page: number) => (page > 1 ? `/review?page=${page}` : "/review");
