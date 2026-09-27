import { describe, expect, it } from "vitest";
import { detectImapPreset, IMAP_PRESETS } from "../src";

describe("detectImapPreset", () => {
  it.each([
    ["priya@gmail.com", "gmail"],
    ["Priya@GoogleMail.com", "gmail"],
    ["a@yahoo.com", "yahoo"],
    ["a@yahoo.co.in", "yahoo"],
    ["a@yahoo.in", "yahoo"],
    ["a@ymail.com", "yahoo"],
    ["a@icloud.com", "icloud"],
    ["a@me.com", "icloud"],
    ["a@mac.com", "icloud"],
    ["a@zoho.com", "zoho"],
    ["a@zohomail.in", "zoho_in"],
    ["a@zoho.in", "zoho_in"],
    ["a@outlook.com", "outlook"],
    ["a@outlook.in", "outlook"],
    ["a@hotmail.co.uk", "outlook"],
    ["a@live.com", "outlook"],
    ["a@msn.com", "outlook"],
  ])("%s -> %s", (email, preset) => {
    expect(detectImapPreset(email)).toBe(preset);
  });

  it.each(["a@company.in", "a@yahoo.evil.example.com", "a@notgmail.com", "gmail.com", "", "a@"])("%s -> null", (email) => {
    expect(detectImapPreset(email)).toBeNull();
  });
});

describe("IMAP_PRESETS", () => {
  it("has every provider on implicit TLS", () => {
    expect(Object.keys(IMAP_PRESETS).sort()).toEqual(["gmail", "icloud", "outlook", "yahoo", "zoho", "zoho_in"]);
    for (const p of Object.values(IMAP_PRESETS)) {
      expect(p.port).toBe(993);
      expect(p.secure).toBe(true);
      expect(p.notes.length).toBeGreaterThan(20);
      if (p.appPasswordUrl) expect(p.appPasswordUrl).toMatch(/^https:\/\//);
    }
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])("does not resolve the prototype key %s to a preset", (key) => {
    // Callers index IMAP_PRESETS with user input; a truthy non-preset would make imapflow connect to localhost.
    expect(IMAP_PRESETS[key]).toBeUndefined();
  });

  it("uses the researched hosts and auth modes", () => {
    expect(IMAP_PRESETS.gmail).toMatchObject({ host: "imap.gmail.com", auth: "app_password", allMailFolder: "[Gmail]/All Mail", appPasswordUrl: "https://myaccount.google.com/apppasswords" });
    expect(IMAP_PRESETS.gmail?.notes).toMatch(/2-Step Verification/);
    expect(IMAP_PRESETS.yahoo?.host).toBe("imap.mail.yahoo.com");
    expect(IMAP_PRESETS.icloud?.host).toBe("imap.mail.me.com");
    expect(IMAP_PRESETS.zoho?.host).toBe("imap.zoho.com");
    expect(IMAP_PRESETS.zoho_in?.host).toBe("imap.zoho.in");
    expect(IMAP_PRESETS.zoho?.notes).toMatch(/IMAP Access/);
    expect(IMAP_PRESETS.outlook).toMatchObject({ host: "outlook.office365.com", auth: "oauth_microsoft", appPasswordUrl: null });
  });
});
