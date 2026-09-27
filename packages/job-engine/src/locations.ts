/** India-focused location normalisation. */

const CITY_ALIASES: Record<string, string[]> = {
  Bengaluru: ["bengaluru", "bangalore", "blr", "bengaluru urban"],
  Hyderabad: ["hyderabad", "hyd", "secunderabad", "cyberabad"],
  Pune: ["pune", "poona"],
  Mumbai: ["mumbai", "bombay", "navi mumbai", "thane"],
  Gurgaon: ["gurgaon", "gurugram", "ggn"],
  Chennai: ["chennai", "madras"],
  Noida: ["noida", "greater noida"],
  Delhi: ["delhi", "new delhi", "delhi ncr", "ncr"],
  Kolkata: ["kolkata", "calcutta"],
  Ahmedabad: ["ahmedabad"],
  Jaipur: ["jaipur"],
  Kochi: ["kochi", "cochin"],
  Coimbatore: ["coimbatore"],
  Indore: ["indore"],
  Chandigarh: ["chandigarh", "mohali"],
  Thiruvananthapuram: ["thiruvananthapuram", "trivandrum"],
};

export const REMOTE_INDIA = "Remote - India";
export const REMOTE_GLOBAL = "Remote - Global";

const aliasToCity = new Map<string, string>();
for (const [city, aliases] of Object.entries(CITY_ALIASES)) {
  aliasToCity.set(city.toLowerCase(), city);
  for (const a of aliases) aliasToCity.set(a, city);
}

/** NCR cities are commonly treated as one commuting region. */
const REGIONS: Record<string, string[]> = {
  NCR: ["Gurgaon", "Noida", "Delhi"],
};

export function normalizeLocation(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ");
  const lower = value.toLowerCase();
  if (/remote/.test(lower)) {
    if (/global|worldwide|anywhere|international/.test(lower)) return REMOTE_GLOBAL;
    return REMOTE_INDIA;
  }
  const first = lower.split(/[,(/|-]/)[0]?.trim() ?? lower;
  return aliasToCity.get(first) ?? aliasToCity.get(lower) ?? value;
}

export function isRemoteLocation(location: string): boolean {
  return /remote/i.test(location);
}

/** Find Indian cities (and remote markers) mentioned in free text. */
export function extractLocationsFromText(text: string): string[] {
  const lower = ` ${(text || "").toLowerCase()} `;
  const found = new Set<string>();
  for (const [alias, city] of aliasToCity) {
    if (alias.length < 4 && alias !== "hyd" && alias !== "ncr") continue;
    const re = new RegExp(`(?<![a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i");
    if (re.test(lower)) found.add(city === "Delhi" && /\bncr\b/.test(lower) ? "Delhi" : city);
  }
  if (/\bremote\b|work from home|\bwfh\b/.test(lower)) {
    found.add(/global|worldwide|anywhere in the world/.test(lower) ? REMOTE_GLOBAL : REMOTE_INDIA);
  }
  return [...found];
}

/** Do two normalised locations describe the same commutable place? */
export function locationsMatch(a: string, b: string): boolean {
  const na = normalizeLocation(a);
  const nb = normalizeLocation(b);
  if (na.toLowerCase() === nb.toLowerCase()) return true;
  for (const cities of Object.values(REGIONS)) {
    if (cities.includes(na) && cities.includes(nb)) return true;
  }
  return false;
}
