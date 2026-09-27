/** Display helpers for the job matches table (pure, no hooks). */

const LAKH = 100_000;
const lakhs = (n: number) => (n / LAKH).toFixed(n % LAKH === 0 ? 0 : 1);

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    // Unknown currency code.
    return `${currency} ${n.toLocaleString("en")}`;
  }
}

/**
 * "12-18 LPA", "12+ LPA", "up to 18 LPA" for INR (or no currency); "$120K-$150K" for other currencies;
 * "" when the job states no salary.
 */
export function salaryRange(min: number | null, max: number | null, currency: string | null): string {
  if (min == null && max == null) return "";
  const cur = currency?.trim().toUpperCase() || "INR";
  if (cur === "INR") {
    if (min != null && max != null) return min === max ? `${lakhs(min)} LPA` : `${lakhs(min)}–${lakhs(max)} LPA`;
    return min != null ? `${lakhs(min)}+ LPA` : `up to ${lakhs(max!)} LPA`;
  }
  if (min != null && max != null) return min === max ? money(min, cur) : `${money(min, cur)}–${money(max, cur)}`;
  return min != null ? `${money(min, cur)}+` : `up to ${money(max!, cur)}`;
}

/** "Bengaluru, Pune +2" (the full list goes in a title attribute). */
export function shortLocations(locations: string[], max = 2): string {
  if (locations.length <= max) return locations.join(", ");
  return `${locations.slice(0, max).join(", ")} +${locations.length - max}`;
}
