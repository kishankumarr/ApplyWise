import type { ImapPreset } from "./types";

/**
 * Mail providers that support IMAP with an app password (all on implicit TLS, port 993), plus Outlook,
 * which only accepts OAuth. `domains` entries ending in ".*" match any top-level domain.
 * Null prototype: callers index it with user input, and "constructor" or "__proto__" must not resolve to
 * a truthy non-preset (imapflow would then connect to its default host, localhost).
 */
export const IMAP_PRESETS: Record<string, ImapPreset> = Object.assign(Object.create(null) as Record<string, ImapPreset>, {
  gmail: {
    label: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    notes:
      "Turn on 2-Step Verification in your Google Account first, then create an app password and paste the 16 characters. Not available for work or school accounts, Advanced Protection, or security-key-only 2-Step Verification. Changing your Google password revokes it. Archived alerts are found too.",
    domains: ["gmail.com", "googlemail.com"],
    auth: "app_password",
    allMailFolder: "[Gmail]/All Mail",
  },
  yahoo: {
    label: "Yahoo Mail",
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://login.yahoo.com/account/security",
    notes: "Open Account security, create an app password under External connections, and paste it here. It keeps working after a password change until you delete it.",
    domains: ["yahoo.*", "ymail.com", "rocketmail.com"],
    auth: "app_password",
  },
  icloud: {
    label: "iCloud Mail",
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://account.apple.com",
    notes:
      "Needs two-factor authentication. Go to Sign-In and Security > App-Specific Passwords and create one. Changing your Apple Account password revokes all app-specific passwords.",
    domains: ["icloud.com", "me.com", "mac.com"],
    auth: "app_password",
  },
  zoho: {
    label: "Zoho Mail",
    host: "imap.zoho.com",
    port: 993,
    secure: true,
    appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
    notes:
      "Turn on IMAP first: Zoho Mail > Settings > Mail Accounts > IMAP Access. With two-factor authentication on, create an app-specific password (Zoho Accounts > Security > App Passwords). New free-plan accounts may not include IMAP; custom-domain accounts use imappro.zoho.com.",
    domains: ["zoho.com", "zohomail.com"],
    auth: "app_password",
  },
  zoho_in: {
    label: "Zoho Mail (India)",
    host: "imap.zoho.in",
    port: 993,
    secure: true,
    appPasswordUrl: "https://accounts.zoho.in/home#security/app_password",
    notes:
      "For accounts in Zoho's India data center. Turn on IMAP first: Zoho Mail > Settings > Mail Accounts > IMAP Access. With two-factor authentication on, create an app-specific password (Zoho Accounts > Security > App Passwords). New free-plan accounts may not include IMAP.",
    domains: ["zohomail.in", "zoho.in"],
    auth: "app_password",
  },
  outlook: {
    label: "Outlook, Hotmail or Microsoft 365",
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    appPasswordUrl: null,
    notes:
      "Microsoft no longer accepts app passwords for Outlook.com, Hotmail or Microsoft 365. Use Sign in with Microsoft instead. If syncing fails after signing in, turn on IMAP in Outlook settings (Mail > Forwarding and IMAP).",
    domains: ["outlook.*", "hotmail.*", "live.*", "msn.com"],
    auth: "oauth_microsoft",
  },
} satisfies Record<string, ImapPreset>);

/** Preset id for an email address by its domain (gmail, yahoo, icloud, zoho, zoho_in, outlook), or null. */
export function detectImapPreset(email: string): string | null {
  const at = email.trim().lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.trim().slice(at + 1).toLowerCase();
  if (!domain) return null;
  for (const [id, preset] of Object.entries(IMAP_PRESETS)) {
    if (preset.domains.some((d) => domainMatches(domain, d))) return id;
  }
  return null;
}

function domainMatches(domain: string, pattern: string): boolean {
  if (!pattern.endsWith(".*")) return domain === pattern;
  // "yahoo.*" matches yahoo.com, yahoo.co.in, yahoo.in ...
  return /^[a-z]{2,}(\.[a-z]{2,})?$/.test(domain.slice(pattern.length - 1)) && domain.startsWith(pattern.slice(0, -1));
}

/** Gmail and Google Workspace IMAP hosts. */
export function isGmailHost(host: string): boolean {
  return /^imap\.(gmail|googlemail)\.com$/i.test(host.trim());
}
