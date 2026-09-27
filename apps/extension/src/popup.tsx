import { useEffect, useState } from "react";
import { extensionApi, loadSelectedHandoff, loadSettings, saveSelectedHandoff, saveSettings, type ExtensionSettings } from "./lib/api";
import { defaultSelected, proposeMappings } from "./lib/form-match";
import { applicationPageUrl, handoffForTab, handoffHint, handoffStatusLabel, onApplySite, prefillMismatch, safeApplyUrl } from "./lib/handoff";
import { applyFills, collectFormFields, collectJobPage } from "./lib/injected";
import type { ExtractedJob, FieldMapping, HandoffItem, PrefillPayload } from "./lib/types";

/**
 * ApplyWise popup. Every action requires an explicit click:
 *  - "Import current job": extract visible job info -> user reviews/edits -> "Confirm import".
 *  - "Manual handoffs": applications the automation handed back (CAPTCHA, login, unsupported flow, failure) or that
 *    the user applies to themselves. "Open apply page" opens the official page in a new tab; "Prefill this page"
 *    starts the prefill flow for that application.
 *  - "Prefill this page": paste code -> review fields -> select -> "Fill selected".
 * The handoff list is fetched when the popup opens or on "Refresh" (never polled). The extension never uploads
 * files and never clicks Submit - the user submits on the employer's page.
 */

const s = {
  wrap: { width: 380, padding: 12, fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#111" },
  h: { fontSize: 15, margin: "0 0 8px" },
  h2: { fontSize: 13, margin: "12px 0 4px" },
  btn: { padding: "6px 10px", borderRadius: 6, border: "1px solid #4f46e5", background: "#4f46e5", color: "#fff", cursor: "pointer", marginRight: 6 },
  ghost: { padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", cursor: "pointer", marginRight: 6 },
  btnSm: { padding: "3px 8px", borderRadius: 6, border: "1px solid #4f46e5", background: "#4f46e5", color: "#fff", cursor: "pointer", marginRight: 6, fontSize: 12 },
  ghostSm: { padding: "3px 8px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", cursor: "pointer", marginRight: 6, fontSize: 12 },
  input: { width: "100%", boxSizing: "border-box" as const, padding: 6, border: "1px solid #ccc", borderRadius: 6, marginTop: 2, marginBottom: 6 },
  note: { fontSize: 11, color: "#555" },
  err: { color: "#b91c1c", fontSize: 12 },
  list: { listStyle: "none", padding: 0, margin: 0, maxHeight: 260, overflowY: "auto" as const },
  item: { border: "1px solid #e5e7eb", borderRadius: 6, padding: 6, marginBottom: 6 },
  itemFocus: { borderColor: "#4f46e5", background: "#eef2ff" },
  box: { border: "1px solid #e5e7eb", borderRadius: 6, padding: 6, marginBottom: 8, background: "#f9fafb" },
  badge: { fontSize: 10, padding: "1px 4px", borderRadius: 4, background: "#fef3c7", color: "#92400e", marginLeft: 4 },
};

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

/** URL of the tab the popup was opened on (available through activeTab); null when unavailable. */
async function activeTabUrl(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ?? null;
  } catch {
    return null;
  }
}

interface HandoffState {
  items: HandoffItem[];
  total: number;
  /** URL of the active tab, to recognise the apply page of a handoff. */
  tabUrl: string | null;
  /** The handoff the user last opened or prefilled (still in the list). */
  lastId: string | null;
}

/** One request to ApplyWise plus the active tab's URL; called when the popup opens and on "Refresh". */
async function fetchHandoffState(st: ExtensionSettings): Promise<HandoffState> {
  const [list, tabUrl, last] = await Promise.all([extensionApi.handoffs(st), activeTabUrl(), loadSelectedHandoff()]);
  return { items: list.items, total: list.total, tabUrl, lastId: list.items.some((i) => i.applicationId === last) ? last : null };
}

function HandoffHintLine({ item }: { item: HandoffItem }) {
  const hint = handoffHint(item);
  return hint ? <div style={hint.tone === "warn" ? s.err : s.note}>{hint.text}</div> : null;
}

function HandoffRow(props: { item: HandoffItem; focus: "tab" | "last" | null; onOpen: () => void; onPrefill: () => void }) {
  const { item, focus } = props;
  const applyUrl = safeApplyUrl(item.job.applyUrl);
  return (
    <li style={{ ...s.item, ...(focus ? s.itemFocus : {}) }}>
      <div>
        <strong>{item.job.title}</strong> · {item.job.company}
        {focus === "tab" ? <span style={s.badge}>this tab</span> : focus === "last" ? <span style={s.badge}>last selected</span> : null}
      </div>
      <div style={s.note}>
        {handoffStatusLabel(item.status)} - {item.reasonLabel}
      </div>
      {item.reasonDetail ? <div style={s.note}>{item.reasonDetail}</div> : null}
      <HandoffHintLine item={item} />
      <div style={{ marginTop: 4 }}>
        <button style={s.ghostSm} onClick={props.onOpen} disabled={!applyUrl} title={applyUrl ?? "No official apply URL - open the application in ApplyWise"}>
          Open apply page
        </button>
        <button style={s.btnSm} onClick={props.onPrefill}>
          Prefill this page
        </button>
      </div>
    </li>
  );
}

export default function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"home" | "import" | "prefill" | "settings">("home");
  const [job, setJob] = useState<ExtractedJob | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [payload, setPayload] = useState<PrefillPayload | null>(null);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [fillResult, setFillResult] = useState<string | null>(null);
  const [handoffState, setHandoffState] = useState<HandoffState | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  /** The handoff the prefill flow is for (null = a code for any application the user applies to). */
  const [prefillFor, setPrefillFor] = useState<HandoffItem | null>(null);

  useEffect(() => {
    void loadSettings().then(async (st) => {
      setSettings(st);
      if (!st.token) return setMode("settings");
      try {
        const r = await extensionApi.me(st);
        setMe(r.name ?? r.email ?? "signed in");
      } catch (e) {
        return setError((e as Error).message);
      }
      try {
        setHandoffState(await fetchHandoffState(st));
      } catch (e) {
        setHandoffError((e as Error).message);
      }
    });
  }, []);

  if (!settings) return <div style={s.wrap}>Loading…</div>;

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handoffs = handoffState?.items ?? null;
  const tabUrl = handoffState?.tabUrl ?? null;
  const tabHandoff = handoffs ? handoffForTab(handoffs, tabUrl) : null;
  const focusOf = (item: HandoffItem): "tab" | "last" | null =>
    tabHandoff?.applicationId === item.applicationId ? "tab" : !tabHandoff && handoffState?.lastId === item.applicationId ? "last" : null;

  const extract = () =>
    run(async () => {
      const tab = await activeTab();
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: collectJobPage });
      setJob(res?.result as ExtractedJob);
      setMode("import");
    });

  const confirmImport = () =>
    run(async () => {
      if (!job) return;
      const r = await extensionApi.importJob(settings, job);
      const first = r.imported[0];
      setImported(first ? `${settings.baseUrl}/jobs/${first.jobId}` : null);
    });

  const rememberHandoff = async (item: HandoffItem) => {
    setHandoffState((prev) => (prev ? { ...prev, lastId: item.applicationId } : prev));
    await saveSelectedHandoff(item.applicationId);
  };

  /** Opens the official apply page in a new tab (user click only; http(s) URLs only). */
  const openApplyPage = (item: HandoffItem) =>
    run(async () => {
      const url = safeApplyUrl(item.job.applyUrl);
      if (!url) throw new Error("This job has no official apply URL. Open the application in ApplyWise instead.");
      await rememberHandoff(item);
      await chrome.tabs.create({ url, active: true });
    });

  const openInApplyWise = (applicationId: string) =>
    run(async () => {
      await chrome.tabs.create({ url: applicationPageUrl(settings.baseUrl, applicationId), active: true });
    });

  const startPrefill = (item: HandoffItem | null) =>
    run(async () => {
      if (item) await rememberHandoff(item);
      setPrefillFor(item);
      setCode("");
      setPayload(null);
      setMappings([]);
      setSelected({});
      setFillResult(null);
      setMode("prefill");
    });

  /** Re-fetch the handoff list (user click on "Refresh" or "Save & connect"). */
  const reloadHandoffs = async (st: ExtensionSettings) => {
    setHandoffError(null);
    try {
      setHandoffState(await fetchHandoffState(st));
    } catch (e) {
      setHandoffError((e as Error).message);
    }
  };

  const refreshHandoffs = () => run(() => reloadHandoffs(settings));

  const loadPrefill = () =>
    run(async () => {
      const p = await extensionApi.prefill(settings, code.trim());
      const mismatch = prefillMismatch(p, prefillFor);
      if (mismatch) throw new Error(mismatch);
      const tab = await activeTab();
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: collectFormFields });
      const m = proposeMappings(res?.result ?? [], p, tab.url ?? "");
      setHandoffState((prev) => (prev ? { ...prev, tabUrl: tab.url ?? null } : prev));
      setPayload(p);
      setMappings(m);
      setSelected(Object.fromEntries(m.map((x) => [x.fieldIndex, defaultSelected(x)])));
    });

  const fill = () =>
    run(async () => {
      const tab = await activeTab();
      const fills = mappings.filter((m) => selected[m.fieldIndex]).map((m) => ({ index: m.fieldIndex, value: m.value }));
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: applyFills, args: [fills] });
      const r = res?.result as { filled: number; skipped: number };
      setFillResult(
        `Filled ${r.filled} field(s)${r.skipped ? `, skipped ${r.skipped}` : ""}. Review the form, attach your resume yourself, then click Submit on the page when you are ready. Afterwards mark the application as submitted in ApplyWise.`,
      );
    });

  const prefillApplyUrl = prefillFor ? safeApplyUrl(prefillFor.job.applyUrl) : null;

  return (
    <div style={s.wrap}>
      <h1 style={s.h}>ApplyWise Copilot</h1>
      <p style={s.note}>{me ? `Signed in: ${me}` : "Not connected"} · acts only when you click · never submits</p>
      {error ? <p style={s.err}>{error}</p> : null}

      {mode === "home" ? (
        <div>
          <p>
            <button style={s.btn} onClick={extract} disabled={!me}>
              Import current job
            </button>
            <button style={s.ghost} onClick={() => startPrefill(null)} disabled={!me}>
              Prefill with a code
            </button>
          </p>

          {me ? (
            <section>
              <h2 style={s.h2}>Manual handoffs{handoffState ? ` (${handoffState.total})` : ""}</h2>
              <p style={s.note}>Applications the automation handed back to you, or that you apply to yourself. You submit them on the employer&apos;s page.</p>
              {tabHandoff ? (
                <p style={s.box}>
                  This tab looks like the apply page for <strong>{tabHandoff.job.title}</strong>.{" "}
                  <button style={s.btnSm} onClick={() => startPrefill(tabHandoff)}>
                    Prefill this page
                  </button>
                </p>
              ) : null}
              {handoffError ? <p style={s.err}>Could not load manual handoffs: {handoffError}</p> : null}
              {handoffs === null ? (
                handoffError ? null : <p style={s.note}>Loading…</p>
              ) : handoffs.length === 0 ? (
                <p style={s.note}>Nothing needs a manual application right now.</p>
              ) : (
                <ul style={s.list}>
                  {handoffs.map((h) => (
                    <HandoffRow key={h.applicationId} item={h} focus={focusOf(h)} onOpen={() => openApplyPage(h)} onPrefill={() => startPrefill(h)} />
                  ))}
                </ul>
              )}
              {handoffState && handoffState.total > handoffState.items.length ? (
                <p style={s.note}>
                  Showing the newest {handoffState.items.length} of {handoffState.total}.
                </p>
              ) : null}
              <button style={s.ghostSm} onClick={refreshHandoffs}>
                Refresh
              </button>
            </section>
          ) : null}

          <p>
            <a href={`${settings.baseUrl}/dashboard`} target="_blank" rel="noreferrer">
              Open dashboard
            </a>{" "}
            ·{" "}
            <a href="#" onClick={() => setMode("settings")}>
              Settings
            </a>
          </p>
        </div>
      ) : null}

      {mode === "settings" ? (
        <div>
          <label>
            ApplyWise URL
            <input style={s.input} value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} />
          </label>
          <label>
            Connection token (Settings → Integrations)
            <input style={s.input} type="password" value={settings.token} onChange={(e) => setSettings({ ...settings, token: e.target.value })} />
          </label>
          <button
            style={s.btn}
            onClick={() =>
              run(async () => {
                await saveSettings(settings);
                const r = await extensionApi.me(settings);
                setMe(r.name ?? r.email ?? "signed in");
                setMode("home");
                await reloadHandoffs(settings);
              })
            }
          >
            Save & connect
          </button>
        </div>
      ) : null}

      {mode === "import" && job ? (
        <div>
          <p style={s.note}>Review what will be sent to ApplyWise. Edit anything that is wrong.</p>
          {(["title", "company", "location", "applyUrl", "contactEmail"] as const).map((k) => (
            <label key={k}>
              {k}
              <input style={s.input} value={job[k] ?? ""} onChange={(e) => setJob({ ...job, [k]: e.target.value })} />
            </label>
          ))}
          <label>
            description ({job.description.length} chars)
            <textarea style={{ ...s.input, height: 120 }} value={job.description} onChange={(e) => setJob({ ...job, description: e.target.value })} />
          </label>
          <p style={s.note}>Page: {job.pageUrl}</p>
          {imported ? (
            <p>
              Imported.{" "}
              <a href={imported} target="_blank" rel="noreferrer">
                Open in ApplyWise
              </a>
            </p>
          ) : (
            <p>
              <button style={s.btn} onClick={confirmImport}>
                Confirm import
              </button>
              <button style={s.ghost} onClick={() => setMode("home")}>
                Cancel
              </button>
            </p>
          )}
        </div>
      ) : null}

      {mode === "prefill" ? (
        <div>
          {prefillFor ? (
            <div style={s.box}>
              <div>
                <strong>{prefillFor.job.title}</strong> · {prefillFor.job.company}
              </div>
              <div style={s.note}>{prefillFor.reasonLabel}</div>
              <HandoffHintLine item={prefillFor} />
              {prefillApplyUrl && tabUrl && !onApplySite(prefillApplyUrl, tabUrl) ? (
                <div style={s.note}>This tab is not on the job&apos;s apply site ({new URL(prefillApplyUrl).hostname}). Make sure you are on the right form.</div>
              ) : null}
            </div>
          ) : null}
          {!payload ? (
            <>
              <label>
                Prefill code (from the application&apos;s Apply tab in ApplyWise, valid 10 minutes)
                <input style={s.input} value={code} onChange={(e) => setCode(e.target.value)} />
              </label>
              {prefillFor ? (
                <p style={s.note}>
                  <a href="#" onClick={() => openInApplyWise(prefillFor.applicationId)}>
                    Create a prefill code in ApplyWise
                  </a>
                </p>
              ) : null}
              <button style={s.btn} onClick={loadPrefill} disabled={code.trim().length < 10}>
                Scan this form
              </button>
              <button style={s.ghost} onClick={() => setMode("home")}>
                Back
              </button>
            </>
          ) : (
            <>
              <p style={s.note}>
                {payload.job.title} at {payload.job.company}. Select the fields to fill:
              </p>
              {mappings.length === 0 ? <p>No matching fields found on this page.</p> : null}
              {mappings.map((m) => (
                <label key={m.fieldIndex} style={{ display: "block", marginBottom: 4 }}>
                  <input type="checkbox" checked={!!selected[m.fieldIndex]} onChange={(e) => setSelected({ ...selected, [m.fieldIndex]: e.target.checked })} />{" "}
                  <strong>{m.fieldLabel || `Field ${m.fieldIndex}`}</strong> ← {m.keyLabel}: <em>{m.value.length > 50 ? `${m.value.slice(0, 50)}…` : m.value}</em>{" "}
                  <span style={s.note}>({m.confidence})</span>
                  {m.needsReview ? <span style={s.badge}>not reviewed - read it first</span> : null}
                </label>
              ))}
              <p style={s.note}>{payload.policy}</p>
              <button style={s.btn} onClick={fill} disabled={!Object.values(selected).some(Boolean)}>
                Fill selected fields
              </button>
              <button style={s.ghost} onClick={() => setMode("home")}>
                Back
              </button>
              {fillResult ? (
                <p>
                  {fillResult}{" "}
                  <a href="#" onClick={() => openInApplyWise(payload.applicationId)}>
                    Open in ApplyWise
                  </a>
                </p>
              ) : null}
              {payload.coverLetter ? (
                <details>
                  <summary>Cover letter{payload.coverLetterReviewed === false ? " (not reviewed in ApplyWise yet - read it before filling)" : ""}</summary>
                  <p style={{ whiteSpace: "pre-wrap" }}>{payload.coverLetter}</p>
                </details>
              ) : null}
              {payload.screeningAnswers.length ? (
                <details>
                  <summary>Screening answers (select above or copy manually)</summary>
                  {payload.screeningAnswers.map((a) => (
                    <p key={a.question}>
                      <strong>{a.question}</strong>
                      {a.reviewed === false ? <span style={s.badge}>not reviewed</span> : null}
                      <br />
                      {a.answer}
                    </p>
                  ))}
                </details>
              ) : null}
              {payload.openQuestions?.length ? (
                <details open>
                  <summary>Answer these yourself on the page</summary>
                  <ul>
                    {payload.openQuestions.map((q) => (
                      <li key={q.question}>
                        {q.question}
                        {q.required ? " (required)" : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
