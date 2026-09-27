/** A company whose public ATS job board was verified to list jobs in India. */
export interface SuggestedCompany {
  name: string;
  /** Board adapter id: greenhouse, lever, ashby, smartrecruiters, workable, recruitee. */
  provider: string;
  slug: string;
  /** Open jobs located in India when verified (snapshot, will drift). */
  indiaJobs: number;
  aliases?: string[];
}

/**
 * Seed directory of India employers on public ATS job-board APIs, live-verified on 2026-09-25
 * (India = at least one job location in India). Most "follow a company" lookups hit this list
 * and need no slug guessing.
 */
export const SUGGESTED_COMPANIES: SuggestedCompany[] = [
  { name: "Razorpay", provider: "greenhouse", slug: "razorpaysoftwareprivatelimited", indiaJobs: 20, aliases: ["Razorpay Software Private Limited"] },
  { name: "Groww", provider: "greenhouse", slug: "groww", indiaJobs: 7 },
  { name: "InMobi", provider: "greenhouse", slug: "inmobi", indiaJobs: 46 },
  { name: "HackerRank", provider: "greenhouse", slug: "hackerrank", indiaJobs: 17 },
  { name: "Druva", provider: "greenhouse", slug: "druva", indiaJobs: 12 },
  { name: "Rubrik", provider: "greenhouse", slug: "rubrik", indiaJobs: 33 },
  { name: "Databricks", provider: "greenhouse", slug: "databricks", indiaJobs: 96 },
  { name: "Adyen", provider: "greenhouse", slug: "adyen", indiaJobs: 6 },
  { name: "CRED", provider: "lever", slug: "cred", indiaJobs: 12, aliases: ["Dreamplug"] },
  { name: "Paytm", provider: "lever", slug: "paytm", indiaJobs: 163, aliases: ["One97 Communications"] },
  { name: "Zeta", provider: "lever", slug: "zeta", indiaJobs: 20 },
  { name: "Meesho", provider: "lever", slug: "meesho", indiaJobs: 54 },
  { name: "Hevo Data", provider: "lever", slug: "hevodata", indiaJobs: 50, aliases: ["Hevo"] },
  { name: "Mindtickle", provider: "lever", slug: "mindtickle", indiaJobs: 17 },
  { name: "FamPay", provider: "lever", slug: "fampay", indiaJobs: 15 },
  { name: "Pocket FM", provider: "lever", slug: "pocketfm", indiaJobs: 2 },
  { name: "Lionbridge", provider: "lever", slug: "lionbridge", indiaJobs: 3 },
  { name: "Sarvam AI", provider: "ashby", slug: "sarvam", indiaJobs: 61, aliases: ["Sarvam"] },
  { name: "Atlan", provider: "ashby", slug: "atlan", indiaJobs: 6 },
  { name: "Ema", provider: "ashby", slug: "ema", indiaJobs: 16 },
  { name: "WisdomAI", provider: "ashby", slug: "Wisdom-AI", indiaJobs: 9, aliases: ["Wisdom AI"] },
  { name: "Lumilens", provider: "ashby", slug: "lumilens", indiaJobs: 20 },
  { name: "Composio", provider: "ashby", slug: "composio", indiaJobs: 2 },
  { name: "Notion", provider: "ashby", slug: "notion", indiaJobs: 4 },
  { name: "Cursor", provider: "ashby", slug: "cursor", indiaJobs: 6, aliases: ["Anysphere"] },
  { name: "Freshworks", provider: "smartrecruiters", slug: "Freshworks", indiaJobs: 30 },
  { name: "Bosch Group", provider: "smartrecruiters", slug: "BoschGroup", indiaJobs: 502, aliases: ["Bosch"] },
  { name: "Mercari India", provider: "workable", slug: "mercari-india", indiaJobs: 10, aliases: ["Mercari"] },
  { name: "Blue Machines AI", provider: "workable", slug: "blue-machines-ai", indiaJobs: 15, aliases: ["Blue Machines"] },
  { name: "Signode", provider: "recruitee", slug: "signode", indiaJobs: 14 },
  { name: "Fulfil.io", provider: "recruitee", slug: "fulfilio", indiaJobs: 2, aliases: ["Fulfil", "Fulfil.IO Inc."] },
];
