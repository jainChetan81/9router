// Maps /api/pii-guard data onto the bindings of PII Guard.dc.html (Claude Design project f24fcbc0).
import { clientOf } from "@/lib/spendClient.js";

const IST = 5.5 * 3600e3;
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const age = (v) => {
  const ms = Date.now() - Date.parse(v);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60e3) return `${Math.max(0, Math.floor(ms / 1e3))}s ago`;
  if (ms < 36e5) return `${Math.floor(ms / 60e3)}m ago`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)}h ago`;
  return `${Math.floor(ms / 864e5)}d ago`;
};
const istDate = (ms) => new Date(ms + IST);
const dayLabel = (ms) => istDate(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const stamp = (v) => { const ms = Date.parse(v); return Number.isFinite(ms) ? `${dayLabel(ms)}, ${istDate(ms).toISOString().slice(11, 16)}` : "—"; };

// "user/tool_result" -> "User · tool result"; "/ocr" suffix kept.
export function place(src) {
  const [r, t, o] = String(src || "").split("/");
  const role = !r || r === "-" ? "Unknown" : cap(r);
  const type = !t || t === "-" ? "" : t.replace(/_/g, " ");
  return (type ? `${role} · ${type}` : role) + (o === "ocr" ? " / ocr" : "");
}

const seg = (on, c, disabled = false) => ({ border: 0, height: 26, padding: "0 10px", borderRadius: 7, font: "inherit", fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? (on ? 0.85 : 0.55) : 1, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5, background: on ? "var(--segon)" : "transparent", color: on ? c || "var(--tx)" : "var(--tx2)", fontWeight: on ? 600 : 400, boxShadow: on ? "0 1px 2px rgba(0,0,0,.08)" : "none" });
const AC = { off: ["var(--seg)", "var(--tx2)"], observe: ["var(--bluebg)", "var(--blue)"], redact: ["var(--acc2)", "var(--acc)"], block: ["var(--violetbg)", "var(--violet)"], leaked: ["var(--redbg)", "var(--red)"], ignored: ["var(--seg)", "var(--tx3)"], allowed: ["var(--seg)", "var(--tx3)"] };
export const ALABEL = { observe: "Observed", redact: "Redacted", block: "Blocked", leaked: "Couldn't redact", ignored: "Marked safe", allowed: "Marked safe", off: "Off" };
export const ACTIONS = ["redact", "observe", "block", "leaked", "allowed"];
export const placeholder = (rule, hash) => (rule === "known" ? `{{vault:#${String(hash).slice(0, 6)}}}` : `{{pii:${rule}#${String(hash).slice(0, 6)}}}`);
const WHY = { redact: "Replaced with a placeholder before the request left this server.", observe: "Logged only. The request was sent unchanged.", block: "The request was stopped with HTTP 400 and never reached the model. The message tells you to /rewind.", leaked: "The rule says Redact, but the value sits where it cannot be changed, so it was sent as is. See the reason above.", allowed: "You marked this value as safe. It is never redacted or blocked.", ignored: "You marked this value as safe. It is never redacted or blocked." };
const ACOL = { Off: "var(--tx2)", Observe: "var(--blue)", Redact: "var(--acc)", Block: "var(--violet)", Default: "var(--tx)" };
const LEAK_TAG = {
  "assistant/thinking": ["In the model's reasoning", "The model repeated the value in its own signed reasoning. The provider rejects the request if that reasoning changes, so it goes back as is. The provider already had the value: it came from an earlier message. Once the turn ends, Redact deletes that reasoning from later requests."],
  key: ["In a JSON key", "The value was a JSON object key. Only values can be replaced, so the key was sent as is."],
  number: ["In a number", "The value was a JSON number. Replacing it with text would break the request, so it was sent as is."],
  body: ["Whole body", "The request body was one bare string, which cannot be edited in place."],
};
const SAMPLES = [["API key", "Deploy with key sk-test-FAKE9x2kQ7mZ4pL1 and ping ops@example.com if it fails."], ["Card + email", "Card 4111 1111 1111 1111 is on file for priya.s@example.com."], ["PAN + phone", "My mobile number is 9876543210 and PAN is ABCPE1234F."]];
const RANGE_SHORT = { Today: "today", "24h": "24 h", "7D": "7 days", "30D": "30 days", "60D": "60 days", All: "90 days" };

// Highlights each finding's match in `text`, in order.
function segments(text, findings) {
  const out = [];
  let pos = 0;
  for (const f of findings) {
    if (!f.match) continue;
    const at = text.indexOf(f.match, pos);
    if (at < 0) continue;
    const [bg, c] = AC[f.action] || AC.observe;
    out.push({ t: text.slice(pos, at), st: {} }, { t: f.match, st: { background: bg, color: c, borderRadius: 4, padding: "1px 3px", fontWeight: 600, boxShadow: "inset 0 -2px 0 " + c } });
    pos = at + f.match.length;
  }
  out.push({ t: text.slice(pos), st: {} });
  return out;
}

// Per-response lookups (client, group label, search text per value). Built once per poll, not per keystroke.
const indexes = new WeakMap();
function indexOf(data, nameOf, gLabelOf, gidOf) {
  let ix = indexes.get(data);
  if (!ix) {
    ix = new Map();
    for (const v of data.summary?.groups || []) {
      const client = clientOf(v.ua || ""), group = gLabelOf(v);
      ix.set(v, { client, group, gid: gidOf(v), ocr: v.sources.some((s) => s.endsWith("/ocr")), text: `${nameOf(v)} ${group} ${v.hash} ${v.preview || ""} ${v.model || ""} ${client}`.toLowerCase() });
    }
    indexes.set(data, ix);
  }
  return ix;
}
export const PAGE = 100, LEAK_PAGE = 20;

export function buildPromptFilterKey(q, session, range) {
  return JSON.stringify([q || "", session || "", range?.preset || "", range?.from || "", range?.to || ""]);
}

export function buildPromptRequestKey(filterKey, cursor) {
  return JSON.stringify([filterKey, cursor ?? null]);
}

export function canLandOnPrompt(currentKey, loadedKey, busy) {
  return currentKey === loadedKey && !busy;
}

export function sessionForOpenPrompt(promptId, promptSessionId, fallbackSessionId) {
  return promptId ? promptSessionId || null : fallbackSessionId || null;
}

// ---- Session view helpers (pure, unit-tested) ----

export function buildSessionFilterKey({ q, ssort, sdesc, sf = {}, range }) {
  return JSON.stringify([q || "", ssort || "", !!sdesc, sf.client || "", sf.provider || "", sf.combo || "", sf.hash || "", sf.findings || "", range?.preset || "", range?.from || "", range?.to || ""]);
}
export function buildSessionRequestKey(filterKey, cursor) {
  return JSON.stringify([filterKey, cursor ?? null]);
}
/** Sorts server rows client-side by the chosen sort; default is last-seen desc as served. */
export function sortSessions(rows, ssort = "last", sdesc = true) {
  const val = (r) => (ssort === "requests" ? r.requests || 0 : ssort === "values" ? r.values || 0 : ssort === "first" ? r.first || 0 : r.last || 0);
  return [...rows].sort((a, b) => (val(a) - val(b)) * (sdesc ? -1 : 1));
}
/** Ordered finding markers across a conversation: (messageId, position key) list from the flat messages. */
export function findingMarkers(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.values?.length) continue;
    for (let i = 0; i < m.values.length; i++) out.push({ messageIndex: m._index, id: String(m.id), value: m.values[i], n: m.values.length, seq: out.length });
  }
  return out;
}
/** Groups conversation rows oldest-first into request groups by the first stored request per message. */
export function groupMessages(rows) {
  const seenReq = new Map();
  const groups = [];
  let index = 0;
  for (const r of rows) {
    const reqId = r.requestId || "";
    if (!seenReq.has(reqId)) {
      seenReq.set(reqId, true);
      groups.push({ requestId: reqId, first: r.ts, messages: [] });
    }
    // One index across all groups: the findings filter and the markers share it.
    r._index = index++;
    groups[groups.length - 1].messages.push(r);
  }
  return groups.map((g, i) => ({ ...g, n: i + 1 }));
}
const PLACEHOLDER = /\{\{pii:[\w-]+#[0-9a-f]{6}\}\}|\{\{vault:#[0-9a-f]{6}\}\}/g;
/** Formats the stored tool-call text "Name JSON" into named lines. Bash-style commands thaw into code. */
export function toolFormat(name, text) {
  const t = String(text || "");
  let args = "", rest = "";
  if (name && t.startsWith(`${name} `)) { args = t.slice(name.length + 1); } else if (name && t.includes(" ")) { args = t; }
  let parsed;
  try { parsed = args.trim().startsWith("{") ? JSON.parse(args.trim()) : undefined; } catch { parsed = undefined; }
  if (name && /^(bash|sh|shell|command)$/i.test(name) && parsed && typeof parsed.command === "string") {
    return { kind: "command", command: parsed.command };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const fields = Object.entries(parsed).map(([k, v]) => ({ key: k, value: typeof v === "string" ? v : JSON.stringify(v) }));
    // A single `command`-like field reads as plain code; never executed.
    if (fields.length === 1 && fields[0].value.length > 60) return { kind: "text", text: fields[0].value };
    return { kind: "fields", fields };
  }
  if (args.trim()) return { kind: "text", text: args };
  return { kind: "text", text: t || "Cannot format arguments" };
}
export const PROSE_LINES = 6;
/** Collapse decision per message: tools and system collapse by default; prose above six lines collapses. */
export function collapseDefault(role, kind, text) {
  if (kind === "tool_use" || kind === "tool_result") return true;
  if (role === "system" || role === "developer") return true;
  const t = String(text || "");
  // Same test as the card's "Show more": many lines or one very long line.
  return t.split("\n").length > PROSE_LINES || t.length > 800;
}

export function effectiveConfig(config = {}, pendingOps = {}) {
  let mode = config.mode || "observe";
  const rules = { ...(config.rules || {}) };
  const ocr = { ...(config.ocr || {}) };
  for (const op of Object.values(pendingOps || {})) {
    const opt = op?.optimistic;
    if (!opt) continue;
    if (opt.mode !== undefined) mode = opt.mode;
    if (opt.ocr) Object.assign(ocr, opt.ocr);
    if (opt.rules) {
      for (const [id, val] of Object.entries(opt.rules)) {
        if (val === "default" || val === null) delete rules[id];
        else rules[id] = val;
      }
    }
  }
  return { ...config, mode, rules, ocr };
}

export function isRefreshingState({ hasData, mode, refreshReason }) {
  return Boolean(hasData) && mode !== "error" && (refreshReason === "range" || refreshReason === "save" || refreshReason === "manual");
}

export function buildView({ data, ui, set, act, range, fit, test, events, samples, pendingOps = {} }) {
  const { config: savedConfig = {}, health: h = {}, summary: sm = {} } = data;
  const config = effectiveConfig(savedConfig, pendingOps);
  const tab = ui.tab;
  const preset = range.preset;
  const rangeShort = preset === "Custom" ? range.label : RANGE_SHORT[preset];
  const mode = config.mode || "observe";
  const overrides = config.rules || {};
  const savedMode = savedConfig.mode || "observe";
  const savedOverrides = savedConfig.rules || {};
  const effOf = (id) => overrides[id] || mode;
  const ruleLabel = Object.fromEntries((data.rules || []).map((r) => [r.id, r.label]));
  const ruleGroup = Object.fromEntries((data.rules || []).map((r) => [r.id, r.group]));
  const groupLabel = Object.fromEntries((data.groups || []).map((g) => [g.id, g.label]));
  const isRulePending = (id) => Boolean(pendingOps[`rule:${id}`] || pendingOps[`group:${ruleGroup[id]}`]);
  const all = sm.groups || [];
  const nameOf = (v) => v.name || ruleLabel[v.rule] || v.rule;
  const gLabelOf = (v) => groupLabel[ruleGroup[v.rule]] || "Other";
  const okScanner = !!h.loaded;
  const ix = indexOf(data, nameOf, gLabelOf, (v) => ruleGroup[v.rule] || "other");

  // Leaks: values that leaked at least once in the range.
  // Dismissed: hidden until the value shows up somewhere new.
  const dismissed = config.dismissed || {};
  const isOpen = (v) => !(dismissed[v.hash] || []).length || (v.leakedWhere || []).some((w) => !dismissed[v.hash].includes(w));
  const leakVals = all.filter((v) => v.actions.includes("leaked") && !v.ignored && isOpen(v));
  const dismissBody = (list) => ({ dismiss: Object.fromEntries(list.map((v) => [v.hash, v.leakedWhere?.length ? v.leakedWhere : ["-"]])) });
  const openN = leakVals.length;
  const leakPages = Math.max(1, Math.ceil(openN / LEAK_PAGE)), leakPage = Math.min(ui.leakPage, leakPages - 1);
  // Rule action buttons ask first; the pending change shows inline under the row. One rule, every value of it.
  const ruleBtns = (rule, key) => {
    const busy = isRulePending(rule);
    const target = pendingOps[`rule:${rule}`]?.target;
    return ["observe", "redact", "block"].map((a) => ({
      label: cap(a),
      disabled: busy,
      pending: busy && target === a,
      style: seg(effOf(rule) === a, ACOL[cap(a)], busy),
      on: () => !busy && effOf(rule) !== a && set({ pending: { key, rule, action: a } }),
    }));
  };
  const pend = ui.pending;
  const pending = (key) => pend?.key === key ? {
    text: `${cap(pend.action)} every ${ruleLabel[pend.rule] || pend.rule} value from now on?${pend.action === "block" ? " The next request with a new value fails with HTTP 400." : pend.action === "observe" ? " Values will be logged but sent unchanged." : ""}`,
    ok: () => {
      const { rule, action } = pend;
      set({ pending: null });
      act(
        { rules: { [rule]: action } },
        `${ruleLabel[rule] || rule} set to ${cap(action)}.`,
        { rules: { [rule]: savedOverrides[rule] || "default" } },
        { opKey: `rule:${rule}`, target: action, optimistic: { rules: { [rule]: action } } },
      );
    },
    cancel: () => set({ pending: null }),
  } : null;
  // Allow always confirms and offers undo. `v` needs hash, preview and a name.
  const allowHash = (hash, name, preview, on) => () => {
    if (pendingOps[`allow:${hash}`]) return;
    if (on && !window.confirm(`Mark ${name} ${preview || "#" + hash} as safe?\n\nThis one value will never be redacted or blocked again, under any rule. Undo it under Allowed values.`)) return;
    act({ ignore: hash, on }, on ? `Allowed ${name} #${hash}.` : `Restored ${name} #${hash}.`, { ignore: hash, on: !on }, { opKey: `allow:${hash}` });
  };
  const allow = (v, on = true) => allowHash(v.hash, nameOf(v), v.preview, on);
  const leaks = (tab === "overview" ? leakVals.slice(leakPage * LEAK_PAGE, (leakPage + 1) * LEAK_PAGE) : []).map((v) => {
    const [tag, why] = LEAK_TAG[v.leakedWhere?.[0]] || ["Could not be changed", "The rule says Redact, but the value sat where it cannot be changed, so it was sent as is."];
    const key = `${v.hash}:${v.rule}`;
    const dismissPending = Boolean(pendingOps[`dismiss:${v.hash}`] || pendingOps.dismissAll);
    const allowPending = Boolean(pendingOps[`allow:${v.hash}`]);
    return {
      rule: nameOf(v), group: gLabelOf(v), hash: v.hash, preview: v.preview || "", tag, why, tip: why, loc: place(v.sources[0]), time: age(v.lastSeen),
      key, client: ix.get(v).client, model: v.model || "—",
      signed: v.leakedWhere?.includes("assistant/thinking"),
      ruleName: nameOf(v),
      view: () => set({ detail: { kind: "value", key } }),
      allow: allow(v), allowPending,
      ruleBtns: ruleBtns(v.rule, key), rulePending: isRulePending(v.rule), pending: pending(key),
      dismiss: () => !dismissPending && act(dismissBody([v]), `Dismissed ${nameOf(v)} ${v.preview || "#" + v.hash}.`, { undismiss: [v.hash] }, { opKey: `dismiss:${v.hash}` }),
      dismissPending,
    };
  });
  // Each reason is explained once, on its first row; later rows keep it as a tooltip on the tag.
  const told = new Set();
  for (const l of leaks) { if (told.has(l.tag)) l.why = ""; else told.add(l.tag); }
  const dismissAllPending = Boolean(pendingOps.dismissAll);
  const dismissAll = openN ? () => {
    if (dismissAllPending) return;
    if (window.confirm(`Dismiss all ${openN}? A value comes back only if it shows up somewhere new.`)) {
      act(dismissBody(leakVals), `Dismissed ${openN}.`, { undismiss: leakVals.map((v) => v.hash) }, { opKey: "dismissAll" });
    }
  } : null;

  const redactRules = (data.rules || []).filter((r) => effOf(r.id) === "redact").length;
  const onRules = (data.rules || []).filter((r) => effOf(r.id) !== "off").length;
  const leakWord = openN === 1 ? "value" : "values";
  const status = !h.module ? { text: "Off · PII_GUARD_MODULE is not set · requests pass unscanned", c: "var(--tx2)", bg: "var(--seg)" }
    : !okScanner ? { text: "Not protecting · scanner not loaded · requests pass unscanned", c: "var(--red)", bg: "var(--redbg)" }
    : mode === "off" && !onRules ? { text: "Off · requests are not scanned", c: "var(--tx2)", bg: "var(--seg)" }
    : openN ? { text: `Protecting · ${redactRules} rules redact · ${openN} ${leakWord} to review in ${rangeShort}`, c: "var(--amber)", bg: "var(--amberbg)" }
    : { text: `Protecting · ${redactRules} rules redact · nothing to review in ${rangeShort}`, c: "var(--green)", bg: "var(--greenbg)" };

  // Health problems, also counted on the Health tab dot.
  const ocr = h.ocr || {}, so = sm.ocr || {}, un = h.unscanned || {};
  const ocrCfg = config.ocr || {};
  const savedOcrCfg = savedConfig.ocr || {};
  const ocrQualPending = Boolean(pendingOps["ocr:quality"]);
  const problems = [];
  if (sm.truncated) problems.push({ icon: "warning", title: "Range is cut short", desc: "The log for this range is too large to read in full, so the oldest events are not counted. Pick a shorter range.", cta: null, bg: "var(--amberbg)", c: "var(--amber)" });
  if (!h.module) problems.push({ icon: "power_off", title: "PII_GUARD_MODULE is not set", desc: "Set it in the service drop-in and restart 9Router.", cta: null, bg: "var(--seg)", c: "var(--tx2)" });
  else if (!okScanner) problems.push({ icon: "error", title: "Scanner not loaded", desc: "Requests still go through, but nothing is scanned. Check the Console Log.", cta: null, bg: "var(--redbg)", c: "var(--red)" });
  if (h.errors > 0) problems.push({ icon: "error", title: `${fmt(h.errors)} scanner errors`, desc: `Last: ${h.lastError || "unknown"}. Requests fail open and are never blocked by an error.`, cta: null, bg: "var(--redbg)", c: "var(--red)" });
  if ((so.status?.partial || 0) > 0) problems.push({
    icon: "image_not_supported",
    title: `${fmt(so.status.partial)} images only partly read`,
    desc: "Mostly small or blurry screenshots. Enhanced quality reads more of them but takes about 3× as long.",
    cta: ocrCfg.quality === "basic" || (ocrQualPending && pendingOps["ocr:quality"]?.target === "enhanced") ? "Try Enhanced" : null,
    ctaPending: ocrQualPending,
    onCta: () => !ocrQualPending && act({ ocr: { quality: "enhanced" } }, "OCR quality set to Enhanced.", { ocr: { quality: savedOcrCfg.quality || "basic" } }, { opKey: "ocr:quality", target: "enhanced", optimistic: { ocr: { quality: "enhanced" } } }),
    bg: "var(--amberbg)",
    c: "var(--amber)",
  });
  if (so.reasons?.queue_full) problems.push({ icon: "warning", title: `OCR queue overflowed ${fmt(so.reasons.queue_full)} times`, desc: "Those images were sent without being scanned; they count in “Images not scanned”. Cached and repeated images no longer use queue space.", cta: null, bg: "var(--amberbg)", c: "var(--amber)" });
  const issues = problems.length;
  const health = issues ? { text: `Scanner: ${issues} ${issues === 1 ? "issue" : "issues"}`, c: !okScanner ? "var(--red)" : "var(--amber)", bg: !okScanner ? "var(--redbg)" : "var(--amberbg)" } : { text: "Scanner OK", c: "var(--green)", bg: "var(--greenbg)" };

  const found = fmt(sm.unique24h);
  const tabs = [["overview", "Overview"], ["findings", "Findings", found], ["rules", "Rules"], ["test", "Test"], ["health", "Health", null, issues ? health.c : null]]
    .map(([k, label, count, dot]) => ({ label, count, dot, on: () => set({ tab: k }), style: { ...seg(tab === k), height: 32, padding: "0 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 6, background: tab === k ? "var(--card)" : "transparent", boxShadow: tab === k ? "0 0 0 1px var(--line2)" : "none" } }));

  // Trend: one bar per hour (≤ 2 days) or IST day.
  const trend = sm.trend || [];
  const hourly = sm.step === 36e5;
  const vmx = Math.max(1, ...trend.map((b) => b.hits));
  const every = Math.ceil(trend.length / 8) || 1;
  const fbars = trend.map((b, i) => {
    const t = sm.origin + i * sm.step;
    return { h: (b.hits / vmx) * 100 + "%", op: 0.75, leak: b.leaks > 0, tick: i % every ? "" : hourly ? istDate(t).toISOString().slice(11, 13) + ":00" : dayLabel(t), title: `${hourly ? stamp(new Date(t).toISOString()) : dayLabel(t)} · ${fmt(b.hits)} hits` };
  });
  // One unit: unique values, each under its latest action. The parts sum to Found. Requests are distinct turns.
  const ba = sm.byAction?.all || { values: {}, requests: {} };
  const ah = sm.actionHits || {};
  const allReq = sm.requests || 0;
  const goFind = (gid, action) => () => set({ tab: "findings", view: "value", fGroup: gid || "", fAction: action || "", page: 0, sel: {} });
  const cards = [["Found", null, "var(--tx)"], ["Redacted", "redact", "var(--acc)"], ["Observed", "observe", "var(--blue)"], ["Blocked", "block", "var(--violet)"], ["Couldn't redact", "leaked", "var(--red)"], ["Marked safe", "allowed", "var(--tx3)"]]
    .map(([label, a, c]) => {
      const values = a ? ba.values[a] || 0 : sm.unique24h || 0;
      const req = a ? ba.requests[a === "allowed" ? "ignored" : a] || 0 : allReq;
      const hits = a ? ah[a === "allowed" ? "ignored" : a] || 0 : Object.values(ah).reduce((x, y) => x + y, 0);
      return { label, value: fmt(values), c: values ? c : "var(--tx3)", sub: `${fmt(req)} ${req === 1 ? "request" : "requests"}`, title: `${fmt(hits)} hits. Hits include history resent each turn, so one value counts again on every later request.`, on: goFind("", a) };
    });
  const sumNote = `${cards.slice(1).map((c) => c.value).join(" + ")} = ${cards[0].value}`;
  // Per rule group: values by action, as counts and a stacked bar.
  const SEGS = [["redact", "var(--acc)"], ["observe", "var(--blue)"], ["block", "var(--violet)"], ["leaked", "var(--red)"], ["allowed", "var(--tx3)"]];
  const split = (ids) => {
    const c = Object.fromEntries(SEGS.map(([a]) => [a, 0]));
    for (const id of ids) for (const [a, nv] of Object.entries(sm.byAction?.[id]?.values || {})) c[a] = (c[a] || 0) + nv;
    const total = Object.values(c).reduce((x, y) => x + y, 0);
    return { c, total, bar: SEGS.filter(([a]) => c[a]).map(([a, color]) => ({ w: (c[a] / (total || 1)) * 100 + "%", color, title: `${fmt(c[a])} ${ALABEL[a].toLowerCase()}` })) };
  };
  const byGroup = (tab === "overview" ? data.groups || [] : []).map((g) => {
    const sp = split((data.rules || []).filter((r) => r.group === g.id).map((r) => r.id));
    return { id: g.id, name: g.label, total: fmt(sp.total), bar: sp.bar, cells: SEGS.slice(0, 4).map(([a]) => ({ n: fmt(sp.c[a]), on: sp.c[a] ? goFind(g.id, a) : null, c: sp.c[a] ? "var(--tx)" : "var(--tx3)" })) };
  }).filter((g) => g.total !== "0");
  const n = { found: cards[0].value };

  const locAll = Object.entries(sm.bySource || {}).sort((a, b) => b[1] - a[1]);
  const maxLoc = locAll[0]?.[1] || 1;
  const locs = (ui.allLoc ? locAll : locAll.slice(0, 5)).map(([s, c]) => ({ name: place(s), hits: fmt(c), w: Math.max(0.6, (c / maxLoc) * 100) + "%" }));
  const clients = new Map();
  if (tab === "overview") for (const v of all) {
    const c = ix.get(v).client;
    const o = clients.get(c) || { values: 0, leaks: 0, models: {} };
    o.values++; if (v.actions.includes("leaked") && !v.ignored) o.leaks++;
    if (v.model) o.models[v.model] = (o.models[v.model] || 0) + 1;
    clients.set(c, o);
  }
  const cl = [...clients.entries()].sort((a, b) => b[1].values - a[1].values);
  const byClient = cl.map(([name, o]) => ({ name, sub: Object.entries(o.models).sort((a, b) => b[1] - a[1])[0]?.[0] || "—", values: fmt(o.values), w: (o.values / (cl[0]?.[1].values || 1)) * 100 + "%", leaks: String(o.leaks), lc: o.leaks ? "var(--red)" : "var(--tx3)" }));

  // Rules
  const confirmBlock = (a) => a !== "Block" || window.confirm("Block stops a request with HTTP 400 the first time a new value appears. After that, the same value is redacted. Continue?");
  const modeOp = pendingOps.mode;
  const modePending = Boolean(modeOp);
  const globalBtns = ["Off", "Observe", "Redact", "Block"].map((a) => {
    const val = a.toLowerCase();
    return {
      label: a,
      disabled: modePending,
      pending: modePending && modeOp.target === val,
      style: seg(mode === val, ACOL[a], modePending),
      on: () => !modePending && mode !== val && confirmBlock(a) && act({ mode: val }, `Default action set to ${a}.`, { mode: savedMode }, { opKey: "mode", target: val, optimistic: { mode: val } }),
    };
  });
  const ocrOn = !!ocr.available;
  const ocrDef = [["mode", "Image OCR", ["Off", "Observe"], ocrOn ? "Reads text inside images. Findings are logged only; images are never changed." : "Set PII_GUARD_OCR=1 in the service drop-in to enable image OCR."],
    ["quality", "OCR quality", ["Basic", "Enhanced"], "Enhanced reads small and rotated text. About 3× slower per image."],
    ["keep", "Keep images", null, ocr.capture ? "On: set by PII_GUARD_CAPTURE_IMAGES. Kept 14 days for OCR replay; backups skip them." : "Off: set PII_GUARD_CAPTURE_IMAGES=1 in the service drop-in."]];
  const ocrRows = ocrDef.map(([k, label, opts, desc]) => {
    const rowOp = pendingOps[`ocr:${k}`];
    const rowPending = Boolean(rowOp);
    return {
      label, desc, hasBtns: !!opts, ro: opts ? null : ocr.capture ? "14 days" : "Off", pending: rowPending,
      btns: (opts || []).map((o) => {
        const val = o.toLowerCase();
        const dis = !ocrOn || rowPending;
        return {
          label: o,
          disabled: dis,
          pending: rowPending && rowOp.target === val,
          style: { ...seg((ocrCfg[k] || "") === val, undefined, rowPending), ...(ocrOn ? {} : { opacity: 0.5, cursor: "not-allowed" }) },
          on: () => ocrOn && !rowPending && (ocrCfg[k] || "") !== val && act(
            { ocr: { [k]: val } },
            `${label} set to ${o}.`,
            { ocr: { [k]: savedOcrCfg[k] || (k === "mode" ? "observe" : "basic") } },
            { opKey: `ocr:${k}`, target: val, optimistic: { ocr: { [k]: val } } },
          ),
        };
      }),
    };
  });
  const groups = (tab === "rules" ? data.groups || [] : []).map((g) => {
    const rs = (data.rules || []).filter((r) => r.group === g.id);
    const set1 = new Set(rs.map((r) => overrides[r.id] || "default"));
    const cur = set1.size === 1 ? cap([...set1][0]) : null;
    const sp = split(rs.map((r) => r.id));
    const open = ui.openGroup === g.id;
    const grpOp = pendingOps[`group:${g.id}`];
    const grpPending = Boolean(grpOp);
    const prevGroupRules = Object.fromEntries(rs.map((r) => [r.id, savedOverrides[r.id] || "default"]));
    return {
      id: g.id, name: g.label, ruleCount: rs.length, total: fmt(sp.total), bar: sp.bar, open, chev: open ? "expand_more" : "chevron_right",
      differs: cur !== "Default", badge: cur ? `${cur} instead of the default (${cap(mode)})` : "Rules in this group differ",
      pending: grpPending || rs.some((r) => Boolean(pendingOps[`rule:${r.id}`])),
      toggle: () => set((u) => ({ openGroup: u.openGroup === g.id ? null : g.id })),
      rules: rs.map((r) => { const x = split([r.id]); return { name: r.label, total: fmt(x.total), bar: x.bar }; }),
      btns: ["Default", "Off", "Observe", "Redact", "Block"].map((a) => {
        const val = a.toLowerCase();
        const nextRules = Object.fromEntries(rs.map((r) => [r.id, val]));
        return {
          label: a,
          disabled: grpPending,
          pending: grpPending && grpOp.target === val,
          style: seg(cur === a, ACOL[a], grpPending),
          on: () => !grpPending && cur !== a && confirmBlock(a) && act(
            { rules: nextRules },
            `${g.label} set to ${a}.`,
            { rules: prevGroupRules },
            { opKey: `group:${g.id}`, target: val, optimistic: { rules: nextRules } },
          ),
        };
      }),
    };
  });

  // Findings: one table. "value" mode groups by value (summary groups, filtered here); "hit" mode pages the
  // event log on the server with the same filters. Action "allowed" = on the allow list now.
  const q = ui.q.toLowerCase();
  const actOf = (v) => (v.ignored ? "allowed" : v.actions.includes("leaked") ? "leaked" : v.action);
  const rows = tab !== "findings" || ui.view !== "value" ? [] : all.filter((v) => { const x = ix.get(v); return (!ui.fAction ? !v.ignored : ui.fAction === "leaked" ? v.actions.includes("leaked") && !v.ignored : actOf(v) === ui.fAction)
    && (!ui.fGroup || x.gid === ui.fGroup) && (!ui.fClient || x.client === ui.fClient)
    && (!ui.fModel || v.model === ui.fModel) && (!ui.fSource || (ui.fSource === "ocr") === x.ocr)
    && (!q || x.text.includes(q)); });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), page = Math.min(ui.page, pages - 1);
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const selKeys = Object.keys(ui.sel).filter((k) => ui.sel[k]);
  const badge = (a) => ({ action: ALABEL[a] || cap(a), abg: (AC[a] || AC.observe)[0], ac: (AC[a] || AC.observe)[1] });
  const byKey = new Map(tab === "findings" || ui.detail ? all.map((v) => [`${v.hash}:${v.rule}`, v]) : []);
  const values = shown.map((v) => {
    const key = `${v.hash}:${v.rule}`, a = actOf(v);
    return {
      key, name: nameOf(v), group: ix.get(v).group, hash: v.hash, preview: v.preview || `#${v.hash}`, became: a === "redact" ? placeholder(v.rule, v.hash) : "—",
      ...badge(a), reqs: fmt(v.turns), last: age(v.lastSeen), client: ix.get(v).client, ocr: ix.get(v).ocr,
      sel: !!ui.sel[v.hash], bg: ui.sel[v.hash] ? "var(--acc2)" : "transparent",
      toggle: () => set((u) => ({ sel: { ...u.sel, [v.hash]: !u.sel[v.hash] } })),
      view: () => set({ detail: { kind: "value", key } }), menu: ui.menu === key, openMenu: () => set((u) => ({ menu: u.menu === key ? null : key })),
      allowLabel: v.ignored ? "Scan this value again" : "Mark value as safe", allow: allow(v, !v.ignored), allowPending: Boolean(pendingOps[`allow:${v.hash}`]),
      ruleBtns: ruleBtns(v.rule, key), rulePending: isRulePending(v.rule), pending: pending(key),
    };
  });
  const sessionRows = (tab === "findings" && ui.view === "session" ? sortSessions(events?.sessionRows || [], ui.ssort, ui.sdesc) : []).map((r) => ({
    sessionId: r.sessionId, short: String(r.sessionId).slice(0, 8), client: r.client || "—",
    route: r.combo || r.model || "—", provider: r.provider || "Not recorded", account: r.account || "",
    first: stamp(new Date(Number(r.first)).toISOString()), last: stamp(new Date(Number(r.last)).toISOString()),
    lastAge: age(new Date(Number(r.last)).toISOString()), requests: fmt(r.requests), messages: fmt(r.messages),
    values: fmt(r.values), hasFindings: r.values > 0, textAvailability: r.hasText ? "Stored" : "Events only",
    open: () => set({ tab: "findings", view: "session", session: r.sessionId, at: "", ssort: ui.ssort, sdesc: ui.sdesc }),
  }));
  const hits = (tab === "findings" && ui.view === "hit" ? (Array.isArray(events) ? events : events?.rows || []) : []).map((e) => ({
    ...e, ...badge(e.a), rule: e.name || ruleLabel[e.rule] || e.rule, sel: !!ui.sel[e.fullHash], bg: ui.sel[e.fullHash] ? "var(--acc2)" : "transparent",
    toggle: () => set((u) => ({ sel: { ...u.sel, [e.fullHash]: !u.sel[e.fullHash] } })),
    view: () => set({ detail: { kind: "hit", hit: e } }),
  }));
  const allowedList = all.filter((v) => v.ignored);
  const allowedIds = config.ignore || [];

  // Detail drawer. Text and image facts come from the event log; values never leave the server unmasked.
  const det = ui.detail;
  let detail = null;
  if (det?.kind === "missing-hit") {
    detail = { title: "Hit details", missingHit: true, hitStatus: det.status, close: () => set({ detail: null }) };
  } else if (det) {
    const hit = det.kind === "hit" ? det.hit : null;
    const v = hit ? byKey.get(`${hit.fullHash}:${hit.rule}`) : byKey.get(det.key);
    const rule = hit?.rule || v?.rule, hash = hit?.fullHash || v?.hash;
    const a = hit ? (allowedIds.includes(hash) ? "allowed" : hit.a) : v ? actOf(v) : "observe";
    const image = hit?.image || (!hit && v?.image) || null;
    detail = {
      title: hit ? hit.rule : v ? nameOf(v) : rule, group: groupLabel[ruleGroup[rule]] || "Other", preview: hit?.preview || v?.preview || "—",
      became: a === "redact" ? placeholder(rule, hash) : a === "block" ? "Request stopped (HTTP 400)" : "Sent as is",
      ...badge(a), why: image && a === "observe" ? "Text in images is observe only. The image was sent unchanged." : WHY[a] || WHY.observe, rule: ruleLabel[rule] || rule, where: hit ? hit.loc : v ? v.sources.map(place).join(", ") : "—",
      context: hit?.context || v?.context || "", noContext: !(hit?.context || v?.context),
      client: hit ? hit.client : v ? ix.get(v).client : "—", model: (hit ? hit.model : v?.model) || "—",
      request: hit?.requestId || v?.requestId || "", session: hit?.sessionId || v?.sessionId || "", hash,
      provider: (hit ? hit.provider : v?.provider) || "Not recorded", combo: (hit ? hit.combo : v?.combo) || "Not recorded",
      account: (hit ? hit.account : v?.account) || "Not recorded", tool: hit?.tool || null, resolvedModel: (hit ? hit.resolvedModel : v?.resolvedModel) || (hit?.provider && hit?.model ? `${hit.provider}/${hit.model}` : hit?.model) || "Not recorded",
      // Prompt lookup: newest stored messages holding this value (each message is stored once per session).
      promptQuery: `hash=${hash}`,
      openSession: (id, sessionId) => {
        const targetSession = sessionForOpenPrompt(id, sessionId, hit?.sessionId || v?.sessionId);
        if (!targetSession) return;
        set({ tab: "findings", view: "prompt", q: "", session: targetSession, at: String(id || ""), detailKey: `${hash}:${rule}`, detailHit: null });
      },
      first: v ? stamp(v.firstSeen) : "—", last: v ? stamp(v.lastSeen) : hit ? stamp(hit.ts) : "—", reqs: v ? fmt(v.turns) : "—",
      image: image ? `/api/pii-guard/image?id=${image}` : null, imageLabel: image ? `Image #${(hit?.imageIndex ?? v?.imageIndex ?? 0) + 1}` : "",
      ruleBtns: rule ? ruleBtns(rule, "detail") : [], rulePending: rule ? isRulePending(rule) : false, pending: pending("detail"),
      allowLabel: a === "allowed" ? "Scan this value again" : "Mark value as safe",
      allowPending: Boolean(hash && pendingOps[`allow:${hash}`]),
      allow: v ? allow(v, a !== "allowed") : allowHash(hash, ruleLabel[rule] || rule, hit?.preview, a !== "allowed"),
      close: () => set({ detail: null, pending: null }),
    };
  }
  const opts = (f) => (tab === "findings" ? [...new Set(all.map(f).filter(Boolean))].sort() : []);

  // Test
  const tr = test.result, ir = test.image?.results?.[0];
  const isImg = ui.testKind === "image", imgOff = !ocrOn || ocrCfg.mode === "off";
  const hitRow = (f) => ({ rule: f.name || ruleLabel[f.rule] || f.rule, group: groupLabel[ruleGroup[f.rule]] || "Other", hash: String(f.hash).slice(0, 6), action: cap(f.action), abg: (AC[f.action] || AC.observe)[0], ac: (AC[f.action] || AC.observe)[1] });
  const tHits = (tab === "test" && (isImg ? ir?.findings : tr?.findings)) || [];
  const blocked = !isImg && tr?.blocked?.length > 0;
  const nR = tHits.filter((f) => f.action === "redact").length, nO = tHits.filter((f) => f.action === "observe").length;
  const textVerdict = test.error ? { text: test.error, bg: "var(--redbg)", c: "var(--red)" } : !tr ? { text: "Scanning…", bg: "var(--seg)", c: "var(--tx2)" } : blocked ? { text: "Request blocked", bg: "var(--redbg)", c: "var(--red)" } : !tHits.length ? { text: "Nothing found", bg: "var(--greenbg)", c: "var(--green)" } : { text: `${nR} redacted · ${nO} observed`, bg: nO ? "var(--bluebg)" : "var(--acc2)", c: nO ? "var(--blue)" : "var(--acc)" };
  const imgVerdict = imgOff ? { text: "Image OCR is Off", bg: "var(--seg)", c: "var(--tx2)" } : test.error ? { text: test.error, bg: "var(--redbg)", c: "var(--red)" } : test.busy || !ir ? { text: "Reading image…", bg: "var(--seg)", c: "var(--tx2)" } : tHits.length ? { text: `${tHits.length} observed · image unchanged`, bg: "var(--bluebg)", c: "var(--blue)" } : { text: "Nothing found", bg: "var(--greenbg)", c: "var(--green)" };
  const sample = samples[ui.imgSel] || null;
  const testOut = isImg ? (imgOff ? "Image OCR is Off. The image is sent unchanged and not scanned." : `The original image, unchanged. ${tHits.length} ${tHits.length === 1 ? "finding" : "findings"} logged as hashes only.`)
    : blocked ? "— Request rejected with HTTP 400. Nothing is sent to the model. —" : tr ? String(tr.redacted ?? tr.before ?? "") : "";

  // Health
  const p95 = h.p95ScanMs ? `p95 ${fmt(h.p95ScanMs)} ms` : "—";
  const up = (() => { const s = (Date.now() - Date.parse(h.since)) / 1e3; return !Number.isFinite(s) ? "—" : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`; })();
  const metrics = [["Scanner errors", fmt(h.errors), "on error, the request still goes through", h.errors ? "var(--red)" : null], ["Requests scanned", fmt(h.requests), `${fmt(h.withFindings)} with findings`], ["Scan latency", p95, h.maxScanMs ? `max ${fmt(h.maxScanMs)} ms` : ""],
    ["Vault values", fmt(h.knownCount), h.knownUpdated ? `updated ${age(h.knownUpdated)}` : ""], ["Images not scanned", fmt(un.images), ocr.enabled ? "queue was full or the file was unreadable" : "image OCR is off", un.images ? "var(--amber)" : null], ["Files not scanned", fmt(un.files), ""],
    ["Encrypted reasoning skipped", fmt(un.opaque), "providers encrypt it, so it cannot be scanned"], ["Uptime", up, `${fmt(h.seen)} values seen`]]
    .map(([label, value, sub, c]) => ({ label, value, sub, c: c || "var(--tx)" }));
  const st = so.status || {};
  const ocrStats = [["Images scanned", fmt(so.totalImages), `${fmt(so.imagesWithHits)} with hits`], ["Read OK", fmt(st.scanned), `${fmt(st.partial)} partial · ${fmt(st.empty)} empty · ${fmt(st.skipped)} skipped`],
    ["Cache hit rate", Math.round((so.cacheHitRate || 0) * 100) + "%", `${fmt(so.cache?.hit)} hit · ${fmt(so.cache?.miss)} miss`], ["OCR latency", so.p95OcrMs ? `p95 ${fmt(so.p95OcrMs)} ms` : "—", "on cache misses"],
    ["Queue", `max ${ocr.queueMax || 32}`, `concurrency ${ocr.concurrency || 1} · overflow ${fmt(so.reasons?.queue_full)} in ${rangeShort}`, so.reasons?.queue_full ? "var(--amber)" : null]].map(([label, value, sub, c]) => ({ label, value, sub, c: c || "var(--tx)" }));
  // Newest first: "28s–1m ago". One label when both ends round to the same age.
  const imgSpan = (newest, oldest) => {
    const a = age(newest), b = age(oldest);
    return a === b ? a : `${a.replace(" ago", "")}–${b}`;
  };
  const imgGroups = [];
  for (const r of so.recent || []) {
    const hit = r.rules?.length > 0, kind = r.status === "skipped" ? "skipped" : hit ? "hit" : "no hits";
    const last = imgGroups.at(-1);
    if (last && last.model === (r.model || "—") && last.kind === kind) { last.n++; last.oldest = r.ts; continue; }
    imgGroups.push({ model: r.model || "—", kind, n: 1, newest: r.ts, oldest: r.ts, rules: r.rules || [], reason: r.reason, cache: r.cache, mode: r.mode });
  }

  const bulkAllowPending = Boolean(pendingOps.bulkAllow);

  return {
    status, health, tabs, rangeShort, okScanner,
    s: { leaks: tab === "overview", numbers: tab === "overview", bygroup: tab === "overview", where: tab === "overview", wording: tab === "rules", mode: tab === "rules", groups: tab === "rules", values: tab === "findings", test: tab === "test", health: tab === "health", ocr: tab === "health" },
    goLeaks: () => set({ tab: "overview" }), goHealth: () => set({ tab: "health" }),
    leaks, noLeaks: leaks.length === 0, leakCount: openN ? `${openN} to review` : "", leakBorder: openN ? "var(--amber)" : "var(--line)", leakIcon: openN ? "gpp_maybe" : "gpp_good", dismissAll, dismissAllPending,
    n, cards, sumNote, byGroup, trendTitle: hourly ? "FINDINGS PER HOUR (IST)" : "FINDINGS PER DAY (IST)", fbars, fgap: trend.length > 40 ? "1px" : "3px",
    locs, toggleLoc: () => set((u) => ({ allLoc: !u.allLoc })), locBtn: ui.allLoc ? "Show top 5" : `Show all ${locAll.length}`, byClient,
    redactRules, globalBtns, modePending, piiEx: "{{pii:email#4b7538}}", ocrRows, groups,
    viewBtns: [["value", "Group by value"], ["hit", "Every hit"], ["prompt", "Prompts"], ["session", "Sessions"]].map(([k, label]) => ({ label, style: seg(ui.view === k), on: () => set({ view: k, sel: {}, page: 0 }) })),
    isValues: ui.view === "value", isEvents: ui.view === "hit", isPrompts: ui.view === "prompt", isSessions: ui.view === "session",
    shownLabel: ui.view === "value" ? (rows.length ? `${fmt(page * PAGE + 1)}–${fmt(page * PAGE + shown.length)} of ${fmt(rows.length)} values` : `0 of ${fmt(all.length)} values`) : ui.view === "prompt" ? "Partially masked · kept 14 days" : ui.view === "session" ? "One row per session · requests without a session stay in Every hit" : `${fmt(hits.length)} hits on this page`,
    groupOpts: (data.groups || []).map((g) => [g.id, g.label]), clientOpts: opts((v) => ix.get(v).client), modelOpts: opts((v) => v.model),
    hasSel: selKeys.length > 0, selCount: selKeys.length,
    allSel: (ui.view === "value" ? values : hits).length > 0 && (ui.view === "value" ? values : hits).every((v) => v.sel),
    toggleAll: () => { const list = ui.view === "value" ? values.map((x) => x.hash) : hits.map((x) => x.fullHash); set({ sel: list.every((h) => ui.sel[h]) ? {} : Object.fromEntries(list.map((h) => [h, true])) }); },
    bulkAllow: () => {
      if (bulkAllowPending) return;
      if (!window.confirm(`Mark ${selKeys.length} ${selKeys.length === 1 ? "value" : "values"} as safe?\n\nThey will never be redacted or blocked again, under any rule. Undo it under Allowed values.`)) return;
      Promise.resolve(act({ ignoreMany: selKeys, on: true }, `Allowed ${selKeys.length} values.`, { ignoreMany: selKeys, on: false }, { opKey: "bulkAllow" }))
        .then((ok) => { if (ok !== false) set({ sel: {} }); });
    },
    bulkAllowPending,
    values, noValues: values.length === 0, hits, noHits: hits.length === 0, sessionRows, noSessions: sessionRows.length === 0,
    prevValues: page > 0 ? () => set({ page: page - 1, sel: {} }) : null, nextValues: page < pages - 1 ? () => set({ page: page + 1, sel: {} }) : null,
    prevLeaks: leakPage > 0 ? () => set({ leakPage: leakPage - 1 }) : null, nextLeaks: leakPage < leakPages - 1 ? () => set({ leakPage: leakPage + 1 }) : null,
    leakPageLabel: leakPages > 1 ? `${leakPage * LEAK_PAGE + 1}–${Math.min(openN, (leakPage + 1) * LEAK_PAGE)} of ${openN}` : "",
    allowedCount: allowedIds.length, showAllowed: !!ui.showAllowed, toggleAllowed: () => set((u) => ({ showAllowed: !u.showAllowed })),
    allowed: allowedIds.map((h) => {
      const v = allowedList.find((x) => x.hash === h);
      const restorePending = Boolean(pendingOps[`allow:${h}`]);
      return {
        hash: h,
        name: v ? nameOf(v) : "Not seen in this range",
        preview: v?.preview || `#${h}`,
        restorePending,
        restore: () => !restorePending && act({ ignore: h, on: false }, `Restored #${h}.`, { ignore: h, on: true }, { opKey: `allow:${h}` }),
      };
    }),
    detail,
    samples: SAMPLES.map(([label, t]) => ({ label, on: () => set({ testText: t }) })),
    kindBtns: [["text", "Text"], ["image", "Image"]].map(([k, label]) => ({ label, style: seg(ui.testKind === k), on: () => set({ testKind: k }) })),
    isText: !isImg, isImage: isImg,
    testSegs: tab !== "test" ? [] : tr ? segments(String(tr.before ?? ""), tr.findings || []) : [{ t: ui.testText, st: {} }],
    imgSegs: tab !== "test" ? [] : ir ? segments(String(ir.text || ""), ir.findings || []) : [{ t: imgOff ? "—" : "Reading…", st: {} }],
    testHits: tHits.map(hitRow), noTestHits: tHits.length === 0,
    noHitsText: isImg ? (imgOff ? "Image OCR is Off, so nothing was read." : "Nothing found in the OCR text.") : "Nothing found. The text would be sent unchanged.",
    testVerdict: isImg ? imgVerdict : textVerdict, testOut,
    thumbs: samples.map((x, i) => ({ short: x.label.split(/,| with | and /)[0], name: x.label, on: () => set({ imgSel: i, upload: null }),
      style: { height: 58, border: 0, borderRadius: 8, cursor: "pointer", background: `center / cover no-repeat url(/pii-guard-samples/${x.file}), var(--seg)`, outline: !ui.upload && ui.imgSel === i ? "2px solid var(--acc)" : "1px solid var(--line2)", outlineOffset: -1, display: "flex", alignItems: "flex-end", justifyContent: "flex-start", padding: 4, color: "var(--tx)", fontSize: 10.5, fontWeight: 600, textShadow: "0 0 3px var(--card)", overflow: "hidden" } })),
    hasUpload: !!ui.upload, hasSample: !ui.upload && !!sample, imgBg: ui.upload ? `center / contain no-repeat url(${ui.upload.url})` : "none", imgName: ui.upload?.name || "",
    sampleName: sample?.label || "", sampleBg: sample ? `center / contain no-repeat url(/pii-guard-samples/${sample.file})` : "none",
    problems, noProblems: problems.length === 0, metrics, ocrStats,
    healthNote: okScanner ? `Scanner loaded · up ${up}` : "Scanner not loaded",
    ocrNote: ocrOn ? `${cap(ocrCfg.mode || "observe")} · ${ocrCfg.quality || "basic"} quality` : "OCR not enabled",
    imgGroups: imgGroups.map((g) => ({ model: g.model, count: `${g.n} ${g.n === 1 ? "image" : "images"}`, status: g.kind === "hit" ? `${g.rules.length} ${g.rules.length === 1 ? "hit" : "hits"}` : g.kind,
      detail: g.kind === "hit" ? g.rules.join(", ") : g.kind === "skipped" ? (g.reason || "skipped").replace(/_/g, " ") : `${g.cache === "hit" ? "from cache" : "scanned"} · ${g.mode || "basic"}`,
      when: imgSpan(g.newest, g.oldest),
      bg: g.kind === "hit" ? "var(--redbg)" : g.kind === "skipped" ? "var(--amberbg)" : "var(--greenbg)", c: g.kind === "hit" ? "var(--red)" : g.kind === "skipped" ? "var(--amber)" : "var(--green)" })),
    noImgGroups: imgGroups.length === 0,
    fit,
  };
}
