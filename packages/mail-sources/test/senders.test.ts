import { describe, expect, it } from "vitest";
import { gmailQuery, matchesSender, normalizeSenders } from "../src/senders";

describe("normalizeSenders", () => {
  it("keeps plain domains and addresses, lowercased and de-duplicated", () => {
    expect(normalizeSenders([" Naukri.com ", "@naukri.com", "jobalerts-noreply@linkedin.com", "mail.foundit.in", "x_y+z@iimjobs.com"])).toEqual([
      "naukri.com",
      "jobalerts-noreply@linkedin.com",
      "mail.foundit.in",
      "x_y+z@iimjobs.com",
    ]);
  });

  it.each(["-naukri.com", "naukri-.com", "-alerts@naukri.com", ".naukri.com", "naukri..com", "naukri", "a b.com", "from:(x.com)", "naukri.com OR x", '"x".com'])(
    "drops %s (it could change the meaning of a search query)",
    (s) => {
      expect(normalizeSenders([s])).toEqual([]);
    },
  );
});

describe("matchesSender", () => {
  const senders = ["naukri.com", "jobalerts-noreply@linkedin.com"];
  it.each([
    ["jobalerts@naukri.com", true],
    ["Alerts@Mail.Naukri.com", true],
    ["jobalerts-noreply@linkedin.com", true],
    ["news@linkedin.com", false],
    ["x@naukri.com.evil.example", false],
    ["x@notnaukri.com", false],
    ["naukri.com", false],
  ])("%s -> %s", (address, expected) => {
    expect(matchesSender(address, senders)).toBe(expected);
  });
});

describe("gmailQuery", () => {
  it("uses epoch seconds and never emits NaN", () => {
    expect(gmailQuery(["naukri.com", "indeed.com"], new Date("2026-09-12T00:00:00Z"))).toBe(`from:(naukri.com OR indeed.com) after:${Date.parse("2026-09-12T00:00:00Z") / 1000}`);
    expect(gmailQuery(["naukri.com"], new Date("not a date"))).toBe("from:(naukri.com) after:0");
    expect(gmailQuery(["naukri.com"], new Date(-5000))).toBe("from:(naukri.com) after:0");
  });
});
