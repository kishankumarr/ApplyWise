import { isIP } from "node:net";
import type { ImapFlow, ImapFlowError, SearchObject } from "imapflow";
import { MailAuthError, MailTransientError } from "./errors";
import { plainCursor } from "./http";
import { parseRawEmail } from "./parse";
import { IMAP_PRESETS, isGmailHost } from "./presets";
import { gmailQuery, matchesSender, normalizeSenders } from "./senders";
import type { FetchOptions, FetchResult, ImapConnection, MailCursor, MailMessage } from "./types";

/**
 * Read-only IMAP access (imapflow): the mailbox is opened with EXAMINE, the search runs on the server by
 * sender, and only matching messages are downloaded. One short-lived connection per call.
 */
export const IMAP_TIMEOUTS = { connectMs: 20_000, greetingMs: 20_000, socketMs: 60_000, lockMs: 20_000, logoutMs: 5_000, runMs: 180_000 } as const;

/** Larger messages are skipped without being downloaded; job alerts are far smaller. */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** imapflow parser limits: well above any message we download, far below the library defaults. */
const IMAP_LIMITS = { maxLineLength: 8 * 1024 * 1024, maxLiteralSize: 16 * 1024 * 1024, maxResponseSize: 32 * 1024 * 1024 } as const;
/** Envelope checks per run (bounds a huge first sync). */
const MAX_CANDIDATES = 500;
const TEST_LOOKBACK_DAYS = 30;

interface ImapCursor {
  mailbox: string;
  /** UIDVALIDITY as a string (it is a bigint in imapflow). */
  uidValidity: string;
  lastUid: number;
}

interface Session {
  client: ImapFlow;
  path: string;
  /** Server supports X-GM-RAW (Gmail search syntax). */
  gmailRaw: boolean;
}

/**
 * Connects, opens the folder read-only and (with `senderDomains`) counts matching alerts from the last
 * 30 days. Never throws: failures come back as ok:false with a friendly message.
 */
export async function testImapConnection(
  conn: ImapConnection,
  opts: { folder?: string; senderDomains?: readonly string[] } = {},
): Promise<{ ok: boolean; message: string; matchingAlerts?: number }> {
  const senders = normalizeSenders(opts.senderDomains ?? []);
  try {
    return await withMailbox(conn, opts.folder, async ({ client, gmailRaw }) => {
      if (!senders.length) return { ok: true, message: "Connected to your mailbox (read-only)." };
      const since = new Date(Date.now() - TEST_LOOKBACK_DAYS * 86_400_000);
      const found = await client.search(buildQuery(senders, since, gmailRaw, 0), { uid: true });
      const n = found ? found.length : 0;
      return {
        ok: true,
        matchingAlerts: n,
        message: n
          ? `Connected. Found ${n} job-alert email${n === 1 ? "" : "s"} from the last ${TEST_LOOKBACK_DAYS} days.`
          : `Connected. No job-alert emails from the last ${TEST_LOOKBACK_DAYS} days yet; new ones will be picked up automatically.`,
      };
    });
  } catch (e) {
    return { ok: false, message: e instanceof MailAuthError || e instanceof MailTransientError ? e.message : "Could not connect to the mailbox." };
  }
}

/**
 * Newest `maxMessages` job-alert emails since the cursor (newest first). Gmail searches All Mail with
 * X-GM-RAW so archived alerts are found; other servers use an OR search on From plus SINCE.
 */
export async function fetchAlertEmailsImap(conn: ImapConnection, opts: FetchOptions): Promise<FetchResult> {
  const base = plainCursor(opts.cursor);
  const senders = normalizeSenders(opts.senderDomains);
  const max = Math.max(0, Math.min(500, Math.floor(Number.isFinite(opts.maxMessages) ? opts.maxMessages : 0)));
  if (!senders.length || !max) return { messages: [], cursor: base };

  const { downloads, imap } = await withMailbox(conn, opts.folder, async ({ client, path, gmailRaw }) => {
    const mailbox = client.mailbox;
    if (!mailbox) throw new MailTransientError("The mailbox could not be opened. Try again in a few minutes.");
    const uidValidity = String(mailbox.uidValidity);
    const prev = readCursor(base);
    // UIDs are only comparable within one folder and one UIDVALIDITY; otherwise start over.
    const lastUid = prev && prev.mailbox === path && prev.uidValidity === uidValidity ? prev.lastUid : 0;

    const found = await client.search(buildQuery(senders, opts.since, gmailRaw, lastUid), { uid: true });
    // "UID n:*" always includes the highest UID even when it is below n.
    const uids = (found || []).filter((u) => u > lastUid).sort((a, b) => a - b);
    const imap: ImapCursor = { mailbox: path, uidValidity, lastUid: Math.max(lastUid, uids.at(-1) ?? 0) };
    if (!uids.length) return { downloads: [], imap };

    // Pass 1: size and envelope only, so oversized or non-matching mail is never downloaded.
    const meta: { uid: number; size: number | null; from: string }[] = [];
    for await (const m of client.fetch(uids.slice(-MAX_CANDIDATES), { uid: true, size: true, envelope: true }, { uid: true })) {
      meta.push({ uid: m.uid, size: m.size ?? null, from: m.envelope?.from?.[0]?.address?.toLowerCase() ?? "" });
    }
    const wanted = meta
      .filter((m) => (m.size ?? 0) <= MAX_MESSAGE_BYTES && matchesSender(m.from, senders))
      .sort((a, b) => a.uid - b.uid)
      .slice(-max);
    const fromByUid = new Map(wanted.map((m) => [m.uid, m.from]));

    // Pass 2: full source of the chosen messages. No other IMAP command may run inside this loop.
    const downloads: { uid: number; from: string; source: Buffer }[] = [];
    if (wanted.length) {
      for await (const m of client.fetch(wanted.map((w) => w.uid), { uid: true, source: true }, { uid: true })) {
        if (m.source && m.source.length <= MAX_MESSAGE_BYTES) downloads.push({ uid: m.uid, from: fromByUid.get(m.uid) ?? "", source: m.source });
      }
    }
    return { downloads, imap };
  });

  // Parsed after the connection is closed.
  const messages: { uid: number; msg: MailMessage }[] = [];
  for (const d of downloads) {
    try {
      const msg = await parseRawEmail(d.source);
      messages.push({ uid: d.uid, msg: msg.from ? msg : { ...msg, from: d.from } });
    } catch {
      // Unparsable message: skipped (the cursor has moved past it).
    }
  }
  return {
    messages: messages.sort((a, b) => b.uid - a.uid).map((m) => m.msg),
    cursor: { ...base, imap },
  };
}

// ---------------------------------------------------------------- session handling

/** Connect, open the folder read-only, run `fn`, and always release the lock and log out. */
async function withMailbox<T>(conn: ImapConnection, folder: string | undefined, fn: (s: Session) => Promise<T>): Promise<T> {
  let client: ImapFlow | null = null;
  let timedOut = false;
  // Whole-run watchdog: closing the socket rejects whatever command is pending.
  const watchdog = setTimeout(() => {
    timedOut = true;
    client?.close();
  }, IMAP_TIMEOUTS.runMs);
  watchdog.unref?.();
  try {
    client = await connect(conn);
    const gmailRaw = client.capabilities.has("X-GM-EXT-1");
    const path = await resolveFolder(client, folder, gmailRaw || isGmailHost(conn.host));
    const lock = await client.getMailboxLock(path, { readOnly: true, acquireTimeout: IMAP_TIMEOUTS.lockMs, description: "applywise alert sync" });
    try {
      return await fn({ client, path, gmailRaw });
    } finally {
      lock.release();
    }
  } catch (e) {
    throw toMailError(e, conn, folder, timedOut);
  } finally {
    clearTimeout(watchdog);
    if (client) await logoutQuietly(client);
  }
}

async function connect(conn: ImapConnection): Promise<ImapFlow> {
  // imapflow silently falls back to localhost:143 for a missing host or port.
  if (!validHost(conn.host) || !Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535 || !conn.user?.trim()) {
    throw new MailAuthError("Mailbox settings are incomplete. Reconnect this mailbox.");
  }
  if (!conn.password && !conn.accessToken) throw new MailAuthError("No app password is saved for this mailbox. Reconnect it.");
  const { ImapFlow } = await import("imapflow");
  const attempt = async (user: string): Promise<ImapFlow> => {
    const client = new ImapFlow({
      host: conn.host.trim(),
      port: conn.port,
      secure: conn.secure === true,
      // Without implicit TLS, STARTTLS is required: opportunistic STARTTLS can be stripped, sending the password in clear.
      ...(conn.secure === true ? {} : { doSTARTTLS: true }),
      auth: conn.accessToken ? { user, accessToken: conn.accessToken } : { user, pass: normalizePassword(conn.host, conn.password ?? "") },
      // The default logger would print protocol traffic; never log mailbox data.
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: IMAP_TIMEOUTS.connectMs,
      greetingTimeout: IMAP_TIMEOUTS.greetingMs,
      socketTimeout: IMAP_TIMEOUTS.socketMs,
      // Parser bounds (defaults are 1-2 GB) so a broken or hostile server cannot exhaust memory.
      ...IMAP_LIMITS,
      clientInfo: { name: "ApplyWise" },
    });
    // Late socket errors arrive as events; without a listener they would crash the process.
    client.on("error", () => undefined);
    try {
      await client.connect();
      return client;
    } catch (e) {
      closeQuietly(client);
      throw e;
    }
  };
  try {
    return await attempt(conn.user);
  } catch (e) {
    // iCloud documents the name part of the address as the user name; try that once.
    const local = conn.user.split("@")[0];
    if (isAuthFailure(e) && /(^|\.)mail\.me\.com$/i.test(conn.host) && conn.user.includes("@") && local) return await attempt(local);
    throw e;
  }
}

/**
 * Gmail's All Mail (special-use \All; localised names differ) instead of INBOX, so archived alerts count.
 * Users can hide All Mail from IMAP (Gmail settings > Labels > Show in IMAP); then INBOX is used.
 */
async function resolveFolder(client: ImapFlow, folder: string | undefined, gmail: boolean): Promise<string> {
  const wanted = folder?.trim() || "INBOX";
  if (!gmail || wanted.toUpperCase() !== "INBOX") return wanted;
  try {
    const boxes = await client.list();
    const fallback = IMAP_PRESETS.gmail?.allMailFolder ?? "[Gmail]/All Mail";
    const all = boxes.find((b) => b.specialUse === "\\All") ?? boxes.find((b) => b.path === fallback);
    if (all) return all.path;
  } catch {
    // LIST failed: INBOX always exists
  }
  return wanted;
}

/** DNS name or IP literal. */
function validHost(host: unknown): host is string {
  if (typeof host !== "string") return false;
  const h = host.trim();
  if (isIP(h)) return true;
  return h.length <= 253 && /^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);
}

function buildQuery(senders: string[], since: Date, gmailRaw: boolean, lastUid: number): SearchObject {
  const from: SearchObject = senders.length > 1 ? { or: senders.map((s) => ({ from: s })) } : { from: senders[0] };
  const q: SearchObject = gmailRaw ? { gmraw: gmailQuery(senders, since) } : { ...from, since };
  if (lastUid > 0) q.uid = `${lastUid + 1}:*`;
  return q;
}

function readCursor(c: MailCursor): ImapCursor | null {
  const v = c.imap as Partial<ImapCursor> | undefined;
  if (!v || typeof v !== "object" || typeof v.mailbox !== "string" || typeof v.uidValidity !== "string") return null;
  if (typeof v.lastUid !== "number" || !Number.isInteger(v.lastUid) || v.lastUid < 0) return null;
  return { mailbox: v.mailbox, uidValidity: v.uidValidity, lastUid: v.lastUid };
}

/** Google shows app passwords as "abcd efgh ijkl mnop"; the spaces (sometimes non-breaking when copied) are only formatting. */
function normalizePassword(host: string, password: string): string {
  const p = password.trim();
  return isGmailHost(host) && /^[a-z]{4}(\s[a-z]{4}){3}$/i.test(p) ? p.replace(/\s/g, "") : p;
}

async function logoutQuietly(client: ImapFlow): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.logout(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("logout timeout")), IMAP_TIMEOUTS.logoutMs);
      }),
    ]);
  } catch {
    closeQuietly(client);
  } finally {
    clearTimeout(timer);
  }
}

function closeQuietly(client: ImapFlow): void {
  try {
    client.close();
  } catch {
    // already closed
  }
}

// ---------------------------------------------------------------- error mapping

function isAuthFailure(e: unknown): boolean {
  return !!e && typeof e === "object" && ((e as ImapFlowError).authenticationFailed === true || (e as Error).name === "AuthenticationFailure");
}

/**
 * imapflow error -> MailAuthError (the user must act) or MailTransientError. Server response text is
 * used only to classify and is never shown (it can echo the user name).
 */
function toMailError(e: unknown, conn: ImapConnection, folder: string | undefined, timedOut = false): MailAuthError | MailTransientError {
  if (e instanceof MailAuthError || e instanceof MailTransientError) return e;
  if (timedOut) return new MailTransientError("The mail server took too long to respond. Try again in a few minutes.", null, "ETIMEOUT");
  const err = (e && typeof e === "object" ? e : {}) as ImapFlowError;
  const code = typeof err.code === "string" ? err.code : "";
  const text = [typeof err.response === "string" ? err.response : "", err.responseText, err.serverResponseCode, err.reason, err.message].filter(Boolean).join(" ");

  if (code === "ETHROTTLE" || /too many (simultaneous )?connections|\[UNAVAILABLE\]|\[LIMIT\]|temporar|try again later|server busy|overloaded|throttl/i.test(text)) {
    return new MailTransientError("The mail server is busy right now. Try again in a few minutes.", err.throttleReset ? Math.ceil(err.throttleReset / 1000) : null, code || "EBUSY");
  }
  if (isAuthFailure(e)) return authError(conn, text);
  if (err.mailboxMissing) return new MailAuthError(`The folder "${(folder?.trim() || "INBOX").slice(0, 100)}" was not found in this mailbox. Choose another folder and reconnect.`);
  if (err.tlsFailed || /^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED/i.test(code)) {
    return new MailTransientError(`Could not open a secure connection to ${conn.host}:${conn.port}. Check the server name and port (IMAP over TLS normally uses 993).`, null, "ETLS");
  }
  if (code === "ENOTFOUND") return new MailTransientError(`Could not find the mail server ${conn.host}. Check the server name and your internet connection.`, null, code);
  if (["ETIMEDOUT", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "LockTimeout"].includes(code)) {
    return new MailTransientError("The mail server did not respond in time. Try again in a few minutes.", null, code);
  }
  if (code === "ECONNREFUSED") return new MailTransientError(`The mail server ${conn.host}:${conn.port} refused the connection. Check the server name and port.`, null, code);
  if (/^E[A-Z]+$|^NoConnection$|^EConnectionClosed$|^StateLogout$|^ClosedAfterConnect/.test(code)) {
    return new MailTransientError("The connection to the mail server was lost. Try again in a few minutes.", null, code);
  }
  return new MailTransientError("The mail server returned an unexpected error. Try again in a few minutes.", null, /^[A-Za-z_]{1,40}$/.test(code) ? code : undefined);
}

function authError(conn: ImapConnection, text: string): MailAuthError {
  if (/not enabled for imap|enable imap|imap.{0,20}(disabled|not enabled|turned off)/i.test(text)) {
    return new MailAuthError("IMAP access is turned off for this mailbox. Turn on IMAP in your email settings, then try again.");
  }
  if (conn.accessToken) {
    return new MailAuthError("Outlook rejected the sign-in. Reconnect Outlook. If it keeps failing, turn on IMAP in Outlook settings (Mail > Forwarding and IMAP).");
  }
  if (/application-specific password|app password required/i.test(text)) {
    return new MailAuthError("Your provider needs an app password, not your normal password. Create an app password and reconnect.");
  }
  if (/web ?login required|via your web browser|WEBALERT/i.test(text)) {
    return new MailAuthError("Your provider blocked the sign-in. Sign in to your email in a web browser, approve any security alert, then try again.");
  }
  if (/(^|\.)outlook\.office365\.com$|(^|\.)outlook\.com$/i.test(conn.host)) {
    return new MailAuthError("Microsoft no longer accepts passwords for IMAP. Use Sign in with Microsoft instead.");
  }
  if (isGmailHost(conn.host)) {
    return new MailAuthError("The app password was rejected. Check that 2-Step Verification is on, create a new app password and reconnect.");
  }
  return new MailAuthError("The app password was rejected. Create a new app password and reconnect.");
}
