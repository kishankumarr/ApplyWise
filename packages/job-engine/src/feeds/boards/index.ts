import type { BoardAdapter, BoardProbe, BoardRef, FeedContext } from "../types";
import { ashbyBoardAdapter } from "./ashby";
import { detectBoardWith } from "./detect";
import { findBoardsWith } from "./finder";
import { greenhouseBoardAdapter } from "./greenhouse";
import { leverBoardAdapter } from "./lever";
import { recruiteeBoardAdapter } from "./recruitee";
import { smartRecruitersBoardAdapter } from "./smartrecruiters";
import { workableBoardAdapter } from "./workable";

export {
  ashbyBoardAdapter,
  greenhouseBoardAdapter,
  leverBoardAdapter,
  recruiteeBoardAdapter,
  smartRecruitersBoardAdapter,
  workableBoardAdapter,
};
export { SUGGESTED_COMPANIES, type SuggestedCompany } from "./directory";
export { detectUnsupportedPortal } from "./detect";
export { FIND_BOARDS_DEADLINE_MS, MAX_BOARD_PROBES, boardNameMatches, boardPageUrl, buildProbePlan, lookupSuggestedCompanies } from "./finder";
export { companyKey, slugCandidatesFor } from "./slugs";

/** Company job boards on public ATS APIs, in "find by name" probe order. */
export const BOARD_ADAPTERS: BoardAdapter[] = [
  greenhouseBoardAdapter,
  leverBoardAdapter,
  ashbyBoardAdapter,
  smartRecruitersBoardAdapter,
  workableBoardAdapter,
  recruiteeBoardAdapter,
];

export function getBoardAdapter(id: string): BoardAdapter | null {
  return BOARD_ADAPTERS.find((a) => a.id === id) ?? null;
}

/** Board behind a pasted careers/job/API URL, or null (unknown host, or a Workable /j/ job link). */
export function detectBoardFromUrl(url: string): BoardRef | null {
  return detectBoardWith(BOARD_ADAPTERS, url);
}

/** Boards that match a company name, most jobs first (directory first, then guessed slugs). */
export function findCompanyBoards(name: string, ctx: FeedContext): Promise<BoardProbe[]> {
  return findBoardsWith(BOARD_ADAPTERS, name, ctx);
}
