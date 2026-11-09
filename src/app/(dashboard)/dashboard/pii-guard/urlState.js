// Pure URL <-> UI state for the PII Guard page. Defaults are omitted from the URL so the bare path stays clean.
export const TABS = ["overview", "findings", "rules", "test", "health"];
export const VIEWS = ["value", "hit", "prompt"];
export const ACTIONS = ["redact", "observe", "block", "leaked", "allowed"];
export const SOURCES = ["text", "ocr"];
export const PRESETS = ["Today", "24h", "7D", "30D", "60D", "All"];
export const DEFAULT_RANGE = { preset: "24h" };
const DEFAULT_TAB = "overview", DEFAULT_VIEW = "value";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const text = (v) => (typeof v === "string" ? v.trim() : "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Real calendar day only: 2026-02-30 and 2026-99-99 are rejected by the UTC round-trip.
export function validDate(v) {
  if (!DATE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
// Same shape as the range picker label: "Nov 1 – Nov 5".
export function rangeLabel(from, to) {
  const f = (v) => { const [, m, d] = v.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
  return `${f(from)} – ${f(to)}`;
}

export function buildRangeKey(range) {
  return JSON.stringify([range?.preset || "", range?.from || "", range?.to || ""]);
}

export function buildEventsFilterKey(range, filters = {}) {
  return JSON.stringify([
    buildRangeKey(range), filters.client || "", filters.model || "", filters.source || "",
    filters.action || "", filters.group || "", filters.q || "", !!filters.tests,
  ]);
}

export function buildEventsRequestKey(filterKey, cursor) {
  return JSON.stringify([filterKey, cursor?.before ?? null, cursor?.skip ?? 0]);
}

// Router updates can echo a URL from an older debounced search after the user has typed again.
export function shouldSyncSearchInput(search, ownSearchWrites, isExternal = false) {
  return isExternal || !ownSearchWrites.has(search);
}

export function shouldDropMissingDetail({ currentKey, loadedKey, succeeded, found }) {
  return !!succeeded && currentKey === loadedKey && !found;
}

// Returns { preset, from?, to?, label? }. Unknown presets and bad custom dates fall back to the default.
export function parseRange(sp) {
  const r = sp.get("range");
  if (r === "custom") {
    const from = sp.get("from") || "", to = sp.get("to") || "";
    if (validDate(from) && validDate(to) && from <= to) return { preset: "Custom", from, to, label: rangeLabel(from, to) };
    return { ...DEFAULT_RANGE };
  }
  return PRESETS.includes(r) && r !== "24h" ? { preset: r } : { ...DEFAULT_RANGE };
}

// Parses search params into the UI slice. Invalid values fall back silently.
export function parseUrlState(sp) {
  const tab = pick(sp.get("tab"), TABS, DEFAULT_TAB);
  const view = pick(sp.get("view"), VIEWS, DEFAULT_VIEW);
  const detail = parseDetail(sp.get("finding"), sp.get("hit"));
  return {
    tab,
    view,
    q: sp.get("q") || "", // raw: the editing value keeps spaces; trim only where it is compared or sent
    fGroup: text(sp.get("group")),
    fAction: pick(sp.get("action"), ACTIONS, ""),
    fClient: text(sp.get("client")),
    fModel: text(sp.get("model")),
    fSource: pick(sp.get("source"), SOURCES, ""),
    tests: sp.get("tests") === "1",
    session: text(sp.get("session")),
    at: text(sp.get("at")),
    detailKey: detail.key,
    detailHit: detail.hit,
    range: parseRange(sp),
  };
}

// `finding=<hash>:<rule>` for value rows (matches view.js key), `hit=<requestId>:<hash>` for event rows.
function parseDetail(finding, hit) {
  const f = text(finding), h = text(hit);
  if (f && /^[^:]+:[^:]+$/.test(f)) return { key: f, hit: null };
  if (h && /^[^:]+:[^:]+$/.test(h)) return { key: null, hit: h };
  return { key: null, hit: null };
}

// Serialises the UI slice back to a URLSearchParams, omitting defaults. `keep` holds params this module does not own.
export function serialiseUrlState(s, keep = new URLSearchParams()) {
  const out = new URLSearchParams(keep);
  for (const k of ["tab", "view", "q", "group", "action", "client", "model", "source", "range", "from", "to", "session", "at", "finding", "hit", "tests"]) out.delete(k);
  const set = (k, v) => { if (v) out.set(k, v); };
  set("tab", s.tab !== DEFAULT_TAB ? s.tab : "");
  set("view", s.view !== DEFAULT_VIEW && s.tab === "findings" ? s.view : "");
  if (s.q && s.q.trim()) out.set("q", s.q);
  set("group", s.fGroup);
  set("action", s.fAction);
  set("client", s.fClient);
  set("model", s.fModel);
  set("source", s.fSource);
  set("tests", s.tests ? "1" : "");
  set("session", s.session);
  set("at", s.at);
  set("finding", s.detailKey || "");
  set("hit", s.detailHit || "");
  const r = s.range || DEFAULT_RANGE;
  if (r.preset === "Custom") { out.set("range", "custom"); out.set("from", r.from); out.set("to", r.to); }
  else if (r.preset && r.preset !== DEFAULT_RANGE.preset) out.set("range", r.preset);
  return out;
}

export function occurrences(text, mark) {
  const positions = [];
  if (!mark) return positions;
  let at = 0;
  while ((at = text.indexOf(mark, at)) !== -1) { positions.push(at); at += mark.length; }
  return positions;
}

// Keeps only drawer params that match a loaded finding. A deep link to a missing finding is dropped.
export function dropMissingDetail(s, hasKey, hasHit) {
  return { ...s, detailKey: s.detailKey && hasKey(s.detailKey) ? s.detailKey : null, detailHit: s.detailHit && hasHit(s.detailHit) ? s.detailHit : null };
}
