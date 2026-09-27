import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAlertEmailsImap, MailAuthError, MailTransientError, testImapConnection, type FetchOptions, type ImapConnection } from "../src";

/** In-memory IMAP server state driving the fake ImapFlow below. */
const h = vi.hoisted(() => {
  interface FakeMessage {
    uid: number;
    from: string;
    size?: number;
    source: Buffer;
  }
  const state = {
    connectErrors: [] as unknown[],
    lockError: null as unknown,
    searchError: null as unknown,
    capabilities: new Map<string, boolean>(),
    folders: [] as { path: string; specialUse?: string }[],
    uidValidity: 7n,
    messages: [] as FakeMessage[],
    clients: [] as {
      options: { auth: { user: string; pass?: string; accessToken?: string }; logger: unknown; host: string };
      locks: { path: string; options: { readOnly?: boolean } }[];
      searches: Record<string, unknown>[];
      fetches: { range: number[]; query: Record<string, unknown> }[];
      released: boolean;
      loggedOut: boolean;
      closed: boolean;
      errorListener: boolean;
    }[],
  };
  return state;
});

vi.mock("imapflow", () => {
  class ImapFlow {
    capabilities = new Map<string, boolean>();
    mailbox: false | { path: string; uidValidity: bigint; uidNext: number; exists: number } = false;
    record: (typeof h.clients)[number];
    constructor(options: (typeof h.clients)[number]["options"]) {
      this.record = { options, locks: [], searches: [], fetches: [], released: false, loggedOut: false, closed: false, errorListener: false };
      h.clients.push(this.record);
    }
    on(event: string) {
      if (event === "error") this.record.errorListener = true;
      return this;
    }
    async connect() {
      const err = h.connectErrors.shift();
      if (err) throw err;
      this.capabilities = h.capabilities;
    }
    async list() {
      return h.folders;
    }
    async getMailboxLock(path: string, options: { readOnly?: boolean }) {
      this.record.locks.push({ path, options });
      if (h.lockError) throw h.lockError;
      this.mailbox = { path, uidValidity: h.uidValidity, uidNext: 1000, exists: h.messages.length };
      return { path, release: () => void (this.record.released = true) };
    }
    async search(query: Record<string, unknown>) {
      this.record.searches.push(query);
      if (h.searchError) throw h.searchError;
      const all = h.messages.map((m) => m.uid);
      const range = typeof query.uid === "string" ? /^(\d+):\*$/.exec(query.uid) : null;
      if (!range) return all;
      const hits = all.filter((u) => u >= Number(range[1]));
      // Real servers: "UID n:*" always returns the highest UID, even when it is below n.
      return hits.length || !all.length ? hits : [Math.max(...all)];
    }
    async *fetch(range: number[], query: Record<string, unknown>) {
      this.record.fetches.push({ range, query });
      for (const uid of range) {
        const m = h.messages.find((x) => x.uid === uid);
        if (!m) continue;
        yield {
          seq: uid,
          uid,
          size: m.size ?? m.source.length,
          envelope: query.envelope ? { from: [{ address: m.from }] } : undefined,
          source: query.source ? m.source : undefined,
        };
      }
    }
    async logout() {
      this.record.loggedOut = true;
    }
    close() {
      this.record.closed = true;
    }
  }
  return { ImapFlow };
});

const eml = (from: string, subject: string, date = "Thu, 25 Sep 2026 09:30:00 +0000") =>
  Buffer.from(`From: Alerts <${from}>\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@test>\r\nContent-Type: text/html\r\n\r\n<p>${subject}</p>\r\n`);

const conn: ImapConnection = { host: "imap.mail.yahoo.com", port: 993, secure: true, user: "priya@yahoo.com", password: "app-pass-1234" };
const since = new Date("2026-09-12T00:00:00Z");
const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({ since, senderDomains: ["naukri.com", "jobalerts-noreply@linkedin.com"], maxMessages: 50, cursor: {}, ...over });
const last = () => h.clients[h.clients.length - 1]!;
const authFailure = (response: string) => Object.assign(new Error("Command failed"), { authenticationFailed: true, response, serverResponseCode: "AUTHENTICATIONFAILED" });

beforeEach(() => {
  h.connectErrors = [];
  h.lockError = null;
  h.searchError = null;
  h.capabilities = new Map([["IMAP4rev1", true]]);
  h.folders = [];
  h.uidValidity = 7n;
  h.clients = [];
  h.messages = [
    { uid: 11, from: "jobs@naukri.com", source: eml("jobs@naukri.com", "Frontend Developer at Kavach", "Mon, 22 Sep 2026 09:00:00 +0000") },
    { uid: 12, from: "jobalerts-noreply@linkedin.com", source: eml("jobalerts-noreply@linkedin.com", "React Engineer at Lotus", "Tue, 23 Sep 2026 09:00:00 +0000") },
    { uid: 13, from: "news@linkedin.com", source: eml("news@linkedin.com", "LinkedIn News digest") },
    { uid: 14, from: "alerts@mail.naukri.com", source: eml("alerts@mail.naukri.com", "Backend Engineer at Tara", "Wed, 24 Sep 2026 09:00:00 +0000") },
  ];
});

describe("fetchAlertEmailsImap", () => {
  it("searches by sender read-only and returns the newest matching alerts first", async () => {
    const r = await fetchAlertEmailsImap(conn, opts());
    const c = last();
    expect(c.options).toMatchObject({ host: "imap.mail.yahoo.com", logger: false, auth: { user: "priya@yahoo.com", pass: "app-pass-1234" } });
    expect(c.errorListener).toBe(true);
    expect(c.locks).toEqual([{ path: "INBOX", options: expect.objectContaining({ readOnly: true }) }]);
    expect(c.searches[0]).toEqual({ or: [{ from: "naukri.com" }, { from: "jobalerts-noreply@linkedin.com" }], since });
    expect(r.messages.map((m) => m.subject)).toEqual(["Backend Engineer at Tara", "React Engineer at Lotus", "Frontend Developer at Kavach"]);
    expect(r.messages[0]).toMatchObject({ from: "alerts@mail.naukri.com", html: expect.stringContaining("Backend Engineer"), messageId: "<BackendEngineeratTara@test>" });
    // news@linkedin.com matched the IMAP search but not the address filter, so its source was never downloaded.
    expect(c.fetches[1]?.range).toEqual([11, 12, 14]);
    expect(r.cursor).toEqual({ imap: { mailbox: "INBOX", uidValidity: "7", lastUid: 14 } });
    expect(c.released).toBe(true);
    expect(c.loggedOut).toBe(true);
  });

  it("uses a single FROM for one sender (imapflow OR needs two or more)", async () => {
    await fetchAlertEmailsImap(conn, opts({ senderDomains: [" @Naukri.com "] }));
    expect(last().searches[0]).toEqual({ from: "naukri.com", since });
  });

  it("searches Gmail's All Mail with X-GM-RAW", async () => {
    h.capabilities = new Map([["X-GM-EXT-1", true]]);
    h.folders = [{ path: "INBOX" }, { path: "[Gmail]/Alle Nachrichten", specialUse: "\\All" }];
    const r = await fetchAlertEmailsImap({ ...conn, host: "imap.gmail.com", user: "priya@gmail.com", password: "abcd efgh ijkl mnop" }, opts({ folder: "INBOX" }));
    const c = last();
    expect(c.options.auth.pass).toBe("abcdefghijklmnop");
    expect(c.locks[0]?.path).toBe("[Gmail]/Alle Nachrichten");
    expect(c.searches[0]).toEqual({ gmraw: `from:(naukri.com OR jobalerts-noreply@linkedin.com) after:${since.getTime() / 1000}` });
    expect(r.cursor).toMatchObject({ imap: { mailbox: "[Gmail]/Alle Nachrichten" } });
  });

  it("uses a listed [Gmail]/All Mail without the \\All flag, and INBOX when All Mail is hidden from IMAP", async () => {
    h.capabilities = new Map([["X-GM-EXT-1", true]]);
    h.folders = [{ path: "INBOX" }, { path: "[Gmail]/All Mail" }];
    await fetchAlertEmailsImap({ ...conn, host: "imap.gmail.com" }, opts());
    expect(last().locks[0]?.path).toBe("[Gmail]/All Mail");

    // Gmail settings > Labels > "Show in IMAP" unticked for All Mail: opening it would fail as "folder not found".
    h.folders = [{ path: "INBOX" }, { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" }];
    const r = await fetchAlertEmailsImap({ ...conn, host: "imap.gmail.com" }, opts());
    expect(last().locks[0]?.path).toBe("INBOX");
    expect(r.cursor).toMatchObject({ imap: { mailbox: "INBOX" } });
  });

  it("strips non-breaking spaces from a pasted Gmail app password only", async () => {
    await fetchAlertEmailsImap({ ...conn, host: "imap.gmail.com", password: "abcd efgh ijkl mnop" }, opts());
    expect(last().options.auth.pass).toBe("abcdefghijklmnop");
    await fetchAlertEmailsImap({ ...conn, password: "abcd efgh ijkl mnop" }, opts());
    expect(last().options.auth.pass).toBe("abcd efgh ijkl mnop");
  });

  it("requires STARTTLS when the connection is not on implicit TLS, and bounds parser memory", async () => {
    await fetchAlertEmailsImap(conn, opts());
    expect(last().options).not.toHaveProperty("doSTARTTLS");
    expect(last().options).toMatchObject({ secure: true, maxLiteralSize: 16 * 1024 * 1024, maxResponseSize: 32 * 1024 * 1024, maxLineLength: 8 * 1024 * 1024 });

    await fetchAlertEmailsImap({ ...conn, host: "mail.example.in", port: 143, secure: false }, opts());
    expect(last().options).toMatchObject({ host: "mail.example.in", port: 143, secure: false, doSTARTTLS: true });
  });

  it.each([
    ["no host", { host: undefined as unknown as string }],
    ["empty host", { host: " " }],
    ["host with a path", { host: "imap.example.com/x" }],
    ["host with a port", { host: "imap.example.com:993" }],
    ["numeric non-IP host", { host: "1.2.3" }],
    ["no port", { port: undefined as unknown as number }],
    ["port 0", { port: 0 }],
    ["port 70000", { port: 70_000 }],
    ["no user", { user: "" }],
  ])("refuses to connect with %s (imapflow would default to localhost:143)", async (_, over) => {
    const err = await fetchAlertEmailsImap({ ...conn, ...over }, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect((err as Error).message).toBe("Mailbox settings are incomplete. Reconnect this mailbox.");
    expect(h.clients).toHaveLength(0);
    expect(await testImapConnection({ ...conn, ...over })).toEqual({ ok: false, message: "Mailbox settings are incomplete. Reconnect this mailbox." });
  });

  it("accepts IP literals as hosts", async () => {
    await fetchAlertEmailsImap({ ...conn, host: "192.0.2.10" }, opts());
    await fetchAlertEmailsImap({ ...conn, host: "2001:db8::1" }, opts());
    expect(h.clients.map((c) => c.options.host)).toEqual(["192.0.2.10", "2001:db8::1"]);
  });

  it("starts fresh from a cursor that is not a plain object", async () => {
    const r = await fetchAlertEmailsImap(conn, opts({ cursor: "corrupt" as unknown as Record<string, unknown> }));
    expect(r.cursor).toEqual({ imap: { mailbox: "INBOX", uidValidity: "7", lastUid: 14 } });
    const empty = await fetchAlertEmailsImap(conn, opts({ cursor: ["x"] as unknown as Record<string, unknown>, senderDomains: [] }));
    expect(empty.cursor).toEqual({});
  });

  it("continues from the cursor and ignores the UID n:* quirk", async () => {
    const cursor = { imap: { mailbox: "INBOX", uidValidity: "7", lastUid: 14 }, other: "kept" };
    const r = await fetchAlertEmailsImap(conn, opts({ cursor }));
    const c = last();
    expect(c.searches[0]).toMatchObject({ uid: "15:*" });
    expect(r.messages).toEqual([]);
    expect(c.fetches).toEqual([]);
    expect(r.cursor).toEqual(cursor);

    h.messages.push({ uid: 20, from: "jobs@naukri.com", source: eml("jobs@naukri.com", "Data Engineer at Veda") });
    const next = await fetchAlertEmailsImap(conn, opts({ cursor }));
    expect(next.messages.map((m) => m.subject)).toEqual(["Data Engineer at Veda"]);
    expect(next.cursor).toEqual({ imap: { mailbox: "INBOX", uidValidity: "7", lastUid: 20 }, other: "kept" });
  });

  it("starts over when UIDVALIDITY or the folder changes", async () => {
    h.uidValidity = 99n;
    const r = await fetchAlertEmailsImap(conn, opts({ cursor: { imap: { mailbox: "INBOX", uidValidity: "7", lastUid: 14 } } }));
    expect(last().searches[0]).not.toHaveProperty("uid");
    expect(r.messages).toHaveLength(3);
    expect(r.cursor).toEqual({ imap: { mailbox: "INBOX", uidValidity: "99", lastUid: 14 } });

    await fetchAlertEmailsImap(conn, opts({ folder: "Jobs", cursor: { imap: { mailbox: "INBOX", uidValidity: "99", lastUid: 14 } } }));
    expect(last().locks[0]?.path).toBe("Jobs");
    expect(last().searches[0]).not.toHaveProperty("uid");
  });

  it("keeps only the newest maxMessages and skips messages over 2 MB without downloading them", async () => {
    h.messages[2] = { uid: 13, from: "jobs@naukri.com", size: 3 * 1024 * 1024, source: eml("jobs@naukri.com", "Huge") };
    const r = await fetchAlertEmailsImap(conn, opts({ maxMessages: 2 }));
    expect(r.messages.map((m) => m.subject)).toEqual(["Backend Engineer at Tara", "React Engineer at Lotus"]);
    expect(last().fetches[1]?.range).toEqual([12, 14]);
    expect(r.cursor).toMatchObject({ imap: { lastUid: 14 } });
  });

  it("does not connect without valid senders", async () => {
    const r = await fetchAlertEmailsImap(conn, opts({ senderDomains: ["not a domain", ""] }));
    expect(r).toEqual({ messages: [], cursor: {} });
    expect(h.clients).toHaveLength(0);
  });

  it("maps a rejected app password to MailAuthError without leaking it", async () => {
    h.connectErrors = [authFailure("[AUTHENTICATIONFAILED] Invalid credentials for priya@yahoo.com app-pass-1234")];
    const err = await fetchAlertEmailsImap(conn, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect((err as Error).name).toBe("MailAuthError");
    expect((err as Error).message).toBe("The app password was rejected. Create a new app password and reconnect.");
    expect((err as Error).message).not.toContain("app-pass-1234");
    expect(last().closed).toBe(true);
  });

  it.each([
    ["[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833", /app password, not your normal password/],
    ["[ALERT] Your account is not enabled for IMAP use.", /IMAP access is turned off/],
    ["You are yet to enable IMAP for your account.", /IMAP access is turned off/],
    ["[ALERT] Please log in via your web browser", /blocked the sign-in/],
    ["[AUTHENTICATIONFAILED] Invalid credentials (Failure)", /2-Step Verification/],
  ])("gives a specific message for %s", async (response, message) => {
    h.connectErrors = [authFailure(response)];
    await expect(fetchAlertEmailsImap({ ...conn, host: "imap.gmail.com" }, opts())).rejects.toThrow(message);
  });

  it("treats 'too many connections' at login as transient", async () => {
    h.connectErrors = [authFailure("[ALERT] Too many simultaneous connections. (Failure)")];
    await expect(fetchAlertEmailsImap(conn, opts())).rejects.toBeInstanceOf(MailTransientError);
  });

  it("maps network failures and timeouts to MailTransientError", async () => {
    h.connectErrors = [Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:993"), { code: "ETIMEDOUT" })];
    const err = await fetchAlertEmailsImap(conn, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransientError);
    expect(err).toMatchObject({ name: "MailTransientError", code: "ETIMEDOUT" });

    h.searchError = Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    await expect(fetchAlertEmailsImap(conn, opts())).rejects.toBeInstanceOf(MailTransientError);
    expect(last().released).toBe(true);
    expect(last().loggedOut).toBe(true);
  });

  it("uses XOAUTH2 with an access token and explains Outlook failures", async () => {
    const outlook = { host: "outlook.office365.com", port: 993, secure: true, user: "priya@outlook.com", accessToken: "ms-access-token" };
    await fetchAlertEmailsImap(outlook, opts());
    expect(last().options.auth).toEqual({ user: "priya@outlook.com", accessToken: "ms-access-token" });

    h.connectErrors = [authFailure("AUTHENTICATE failed.")];
    const err = await fetchAlertEmailsImap(outlook, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect((err as Error).message).toMatch(/Reconnect Outlook/);
    expect((err as Error).message).not.toContain("ms-access-token");
  });

  it("retries iCloud once with the name part of the address", async () => {
    h.connectErrors = [authFailure("[AUTHENTICATIONFAILED] Authentication failed.")];
    const r = await fetchAlertEmailsImap({ ...conn, host: "imap.mail.me.com", user: "priya.s@icloud.com" }, opts());
    expect(h.clients.map((c) => c.options.auth.user)).toEqual(["priya.s@icloud.com", "priya.s"]);
    expect(r.messages).toHaveLength(3);
  });
});

describe("testImapConnection", () => {
  it("counts matching alerts from the last 30 days", async () => {
    const r = await testImapConnection(conn, { senderDomains: ["naukri.com", "linkedin.com"] });
    expect(r).toEqual({ ok: true, matchingAlerts: 4, message: "Connected. Found 4 job-alert emails from the last 30 days." });
    const q = last().searches[0] as { since: Date };
    expect(Date.now() - q.since.getTime()).toBeGreaterThan(29 * 86_400_000);
    expect(last().locks[0]?.options.readOnly).toBe(true);
    expect(last().loggedOut).toBe(true);
  });

  it("just connects without senders", async () => {
    expect(await testImapConnection(conn)).toEqual({ ok: true, message: "Connected to your mailbox (read-only)." });
    expect(last().searches).toEqual([]);
  });

  it("never throws: auth, folder and network problems come back as ok:false", async () => {
    h.connectErrors = [authFailure("[AUTHENTICATIONFAILED] Invalid credentials")];
    expect(await testImapConnection(conn)).toEqual({ ok: false, message: "The app password was rejected. Create a new app password and reconnect." });

    h.lockError = Object.assign(new Error("Mailbox doesn't exist"), { mailboxMissing: true });
    const missing = await testImapConnection(conn, { folder: "Job Alerts" });
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining('"Job Alerts" was not found') });

    h.lockError = null;
    h.connectErrors = [Object.assign(new Error("getaddrinfo ENOTFOUND imap.example.test"), { code: "ENOTFOUND" })];
    expect(await testImapConnection({ ...conn, host: "imap.example.test" })).toEqual({
      ok: false,
      message: "Could not find the mail server imap.example.test. Check the server name and your internet connection.",
    });

    expect(await testImapConnection({ ...conn, password: "" })).toMatchObject({ ok: false, message: expect.stringMatching(/No app password/) });
  });
});
