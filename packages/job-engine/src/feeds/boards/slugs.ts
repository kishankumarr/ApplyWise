import { stripDiacritics } from "../util";

/**
 * Board-token guessing for "follow a company by name". Tokens usually are the brand in one word
 * (razorpay, hevodata), hyphenated (blue-machines-ai), with a suffix (mercari-india), or the Indian
 * legal entity on Greenhouse (razorpaysoftwareprivatelimited).
 */

const LEGAL_WORDS = new Set(["pvt", "private", "ltd", "limited", "inc", "llc", "llp", "plc", "corp", "corporation", "gmbh", "co"]);
const BRAND_SUFFIXES = new Set(["ai", "labs", "lab", "tech", "technologies", "technology", "india", "hq", "software", "solutions"]);

export interface NameParts {
  /** "razorpay", "hevodata", "bluemachinesai" */
  compact: string;
  /** "blue-machines-ai", "wisdom-ai" */
  hyphen: string;
  /** Name without a trailing ai/labs/tech/india/software suffix: "bluemachines". */
  brand: string;
  brandHyphen: string;
}

export function nameParts(name: string): NameParts | null {
  const words = stripDiacritics(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2") // "WisdomAI" -> "Wisdom AI"
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !LEGAL_WORDS.has(w));
  if (words.length === 0) return null;
  const brandWords = [...words];
  while (brandWords.length > 1 && BRAND_SUFFIXES.has(brandWords[brandWords.length - 1]!)) brandWords.pop();
  return {
    compact: words.join(""),
    hyphen: words.join("-"),
    brand: brandWords.join(""),
    brandHyphen: brandWords.join("-"),
  };
}

type CandidateStyle = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable" | "recruitee";

/** Ordered, de-duplicated slug candidates for one provider (most likely first, at most 8). */
export function slugCandidatesFor(style: CandidateStyle, companyName: string): string[] {
  const p = nameParts(companyName);
  if (!p) return [];
  const { compact, hyphen, brand, brandHyphen } = p;
  const lists: Record<CandidateStyle, string[]> = {
    greenhouse: [
      compact,
      brand,
      `${brand}softwareprivatelimited`,
      `${brand}technologiesprivatelimited`,
      hyphen,
      `${brand}india`,
      `${brand}privatelimited`,
      `${brand}hq`,
      `${brand}technologies`,
    ],
    lever: [compact, hyphen, brand, `${brand}india`, `${brand}hq`, `${brand}technologies`, `${brandHyphen}-india`, `${brand}app`],
    ashby: [compact, hyphen, brand, `${brand}hq`, `${brand}ai`, `${brand}india`, `${brand}labs`],
    smartrecruiters: [compact, brand, `${brand}group`, `${brand}india`, `${brand}technologies`],
    workable: [compact, hyphen, `${brandHyphen}-india`, brand, `${brand}india`, `${hyphen}-1`, `${brand}hq`],
    recruitee: [compact, hyphen, brand, `${brand}india`],
  };
  return [...new Set(lists[style].filter((s) => s.length >= 2))].slice(0, 8);
}

/** Case/space/punctuation-insensitive key for directory lookups: "Sarvam AI" -> "sarvamai". */
export function companyKey(name: string): string {
  return stripDiacritics(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Key without legal-entity words: "Razorpay Software Pvt. Ltd." -> "razorpaysoftware". */
export function companyKeyWithoutLegal(name: string): string {
  return nameParts(name)?.compact ?? companyKey(name);
}
