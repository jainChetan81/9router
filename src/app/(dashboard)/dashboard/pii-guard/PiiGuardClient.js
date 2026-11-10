"use client";

import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { occurrences, parseUrlState, serialiseUrlState, buildRangeKey, buildEventsFilterKey, buildEventsRequestKey, nextHitLookupCursor, clearPromptLandingOnNavigation, shouldSyncSearchInput, shouldDropMissingDetail } from "./urlState";
import RangeBar from "../spend/RangeBar";
import { applyIgnoreToSummary } from "@/lib/piiGuard/summary";
import { buildView, isRefreshingState, place, PAGE, buildPromptFilterKey, buildPromptRequestKey, canLandOnPrompt, buildSessionFilterKey, buildSessionRequestKey, findingMarkers, groupMessages, toolFormat, collapseDefault, PROSE_LINES, ALABEL, stamp, age } from "./view";
import "../spend/spend.css";
import RefreshBar from "../spend/RefreshBar";
import { cacheGet, cacheSet } from "@/lib/clientCache";

const summaryKey = (rk) => `/api/pii-guard?range=${rk}`;

const DAY = 864e5, IST = 5.5 * 3600e3;
const PRESET_DAYS = { "7D": 7, "30D": 30, "60D": 60, All: 90 };
// Range in ms for the API; the event log keeps at most 90 days.
function bounds(r, now = Date.now()) {
  if (r.preset === "Today") return { from: Math.floor((now + IST) / DAY) * DAY - IST, to: now };
  if (r.preset === "Custom") {
    const to = Math.min(now, Date.parse(r.to + "T00:00:00Z") - IST + DAY);
    return { from: Math.max(Date.parse(r.from + "T00:00:00Z") - IST, to - 90 * DAY), to };
  }
  return { from: now - (PRESET_DAYS[r.preset] || 1) * DAY + (r.preset === "All" ? 6e4 : 0), to: now };
}
async function call(url, body, signal) {
  const res = await fetch(url, { cache: "no-store", signal, ...(body && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const hhmmss = (ts) => new Date(Date.parse(ts) + IST).toISOString().slice(11, 19);
const toB64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = bad; r.readAsDataURL(file); });
function eventRows(events) {
  const rows = [];
  for (const e of events) (e.hits || []).forEach((h, i) => rows.push({ id: `${e.ts}:${e.requestId || ""}:${h.hash}:${h.rule}:${i}`, ts: e.ts, t: hhmmss(e.ts), rule: h.rule, name: h.name, hash: String(h.hash).slice(0, 6), fullHash: h.hash, preview: h.preview || "", context: h.context || "",
    loc: e.type === "ocr" ? `${place(String(h.source || "").replace(/\/ocr$/, ""))} · image #${(e.imageIndex ?? 0) + 1}` : place(h.source), a: h.action === "ignored" ? "allowed" : h.action || "observe", model: e.model || "—", client: e.client || "—",
    test: e.type === "test" || e.test === true, requestId: e.requestId || "", sessionId: e.sessionId || "", image: e.type === "ocr" ? e.sha256Prefix || null : null, imageIndex: e.imageIndex, req: e.requestId ? `${e.requestId.slice(0, 6)}…${e.requestId.slice(-2)}` : "—" }));
  return rows;
}

export default function PiiGuardClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const urlState = useMemo(() => parseUrlState(new URLSearchParams(search)), [search]);
  // Keyed by its values, so a change to another param keeps the same range object and event pagination.
  const rangeKey = buildRangeKey(urlState.range);
  const range = useMemo(() => urlState.range, [rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [loadedSummary, setLoadedSummary] = useState({ key: null, data: null });
  const data = loadedSummary.data;
  const dataRef = useRef(null);
  dataRef.current = data;
  const loadedKeyRef = useRef(null);
  const [pollSeq, setPollSeq] = useState(0);
  const [refreshReason, setRefreshReason] = useState(null);
  const [mode, setMode] = useState("loading");
  const [errorText, setErrorText] = useState("");
  const [eventData, setEventData] = useState({ key: null, status: "idle", rows: [], next: null });
  const [hitLookup, setHitLookup] = useState({ key: null, status: "idle", hit: null });
  // Event log shows one fixed page. `evPage`: cursors of the pages above the current one (empty = newest page).
  const [evPageState, setEvPageState] = useState({ key: null, list: [] });
  const [samples, setSamples] = useState([]);
  const [toastState, setToast] = useState(null);
  const [errorToast, setErrorToast] = useState(null);
  const [undoPending, setUndoPending] = useState(false);
  const [pendingOps, setPendingOps] = useState({});
  const pendingOpsRef = useRef({});
  const opSeqRef = useRef(0);
  const toastTimerRef = useRef(null);
  const [test, setTest] = useState({ result: null, image: null, error: "", busy: false });
  const [local, setLocal] = useState({ openGroup: null, allLoc: false, sel: {}, page: 0, leakPage: 0, pending: null, menu: null, showAllowed: false,
    testKind: "text", testText: "My mobile number is 9876543210 and PAN is ABCPE1234F.", testMode: "current", testWhere: "user", imgSel: 0, upload: null });
  const [searchInput, setSearchInput] = useState(urlState.q);
  const pendingUrl = useRef(urlState), searchTimer = useRef(null);
  const ownSearchWrites = useRef(new Map()), externalUrlChange = useRef(false), hitCache = useRef(new Map());
  useEffect(() => {
    const onPopState = () => { externalUrlChange.current = true; };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const external = externalUrlChange.current;
    externalUrlChange.current = false;
    const writes = ownSearchWrites.current;
    const ownEcho = writes.has(search);
    const sync = shouldSyncSearchInput(search, writes, external);
    if (ownEcho) {
      const count = writes.get(search);
      if (count > 1) writes.set(search, count - 1); else writes.delete(search);
    }
    if (!sync) return;
    pendingUrl.current = urlState;
    setSearchInput(urlState.q);
    clearTimeout(searchTimer.current);
  }, [search, urlState]);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  const dq0 = useDeferredValue(searchInput);
  const eventsFilterKey = buildEventsFilterKey(range, { client: urlState.fClient, model: urlState.fModel, source: urlState.fSource,
    action: urlState.fAction, group: urlState.fGroup, q: dq0, tests: urlState.tests });
  const evPage = evPageState.key === eventsFilterKey ? evPageState.list : [];
  const evCursor = evPage.at(-1)?.cursor || null, evNewest = evPage.length === 0;
  const evRequestKey = buildEventsRequestKey(eventsFilterKey, evCursor);
  const eventRequestCurrent = eventData.key === evRequestKey;
  const eventsReady = eventRequestCurrent && eventData.status === "success";
  const evBusy = !eventRequestCurrent || eventData.status === "loading";
  const rawEvents = useMemo(() => eventsReady ? eventData.rows : [], [eventsReady, eventData.rows]);
  // Sessions list: fetched separately (its own key + internals state); paged into the "hit" shape.
  // Read URL state directly: `ui` is built further down from these values.
  const sessFilterKey = urlState.view === "session" && urlState.tab === "findings" && !urlState.session
    ? buildSessionFilterKey({ q: searchInput, ssort: urlState.ssort, sdesc: urlState.sdesc, sf: urlState.sf, range }) : null;
  const [sessData, setSessData] = useState({ key: null, status: "idle", rows: [], next: null });
  useEffect(() => {
    if (!sessFilterKey) return;
    const ctl = new AbortController();
    setSessData({ key: sessFilterKey, status: "loading", rows: [], next: null });
    // Build the query from the key values.
    const [q, , , sclient, sprovider, scombo, shash, sfind, preset, from, to] = JSON.parse(sessFilterKey);
    const { from: fms, to: tms } = bounds({ preset: preset || "Custom", from: from || "", to: to || "" });
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (sclient) qs.set("client", sclient);
    if (sprovider) qs.set("provider", sprovider);
    if (scombo) qs.set("combo", scombo);
    if (shash) qs.set("hash", shash);
    if (sfind) qs.set("findings", sfind);
    qs.set("from", String(Math.round(fms)));
    qs.set("to", String(Math.round(tms)));
    call(`/api/pii-guard/sessions?${qs.toString()}`, null, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setSessData({ key: sessFilterKey, status: r.unavailable ? "error" : "success", rows: r.rows || [], next: r.next ?? null }); })
      .catch(() => { if (!ctl.signal.aborted) setSessData({ key: sessFilterKey, status: "error", rows: [], next: null }); });
    return () => ctl.abort();
  }, [sessFilterKey, range]);
  const sessReady = sessData.key === sessFilterKey && sessData.status !== "loading" && sessData.status !== "idle";
  const eventRowsAll = useMemo(() => (sessFilterKey && sessReady ? { sessionRows: sessData.rows } : {}), [sessFilterKey, sessReady, sessData]);
  const evNext = eventsReady ? eventData.next : null;
  const hitCacheKey = urlState.detailHit ? `${rangeKey}:${urlState.detailHit}` : null;
  const pageHit = rawEvents.find((e) => `${e.requestId}:${e.fullHash}` === urlState.detailHit) || (hitCacheKey && hitCache.current.get(hitCacheKey));
  const currentHitLookup = hitCacheKey && hitLookup.key === hitCacheKey ? hitLookup : null;
  const hit = pageHit || currentHitLookup?.hit;
  const hitStatus = hit ? "success" : currentHitLookup?.status || "loading";
  const ui = useMemo(() => ({ ...local, ...urlState, q: searchInput, detail: urlState.at && urlState.view === "prompt" ? null : urlState.detailKey ? { kind: "value", key: urlState.detailKey } : urlState.detailHit ? hit ? { kind: "hit", hit } : { kind: "missing-hit", status: hitStatus } : null }), [local, urlState, searchInput, hit, hitStatus]);
  const currentUi = useRef(ui); currentUi.current = ui;
  const set = useCallback((update) => {
    const p = typeof update === "function" ? update(currentUi.current) : update;
    const keys = ["tab", "view", "q", "fGroup", "fAction", "fClient", "fModel", "fSource", "tests", "session", "at", "range", "detailKey", "detailHit"];
    const next = { ...pendingUrl.current }, rest = {};
    let changed = false, navigation = false;
    for (const [key, value] of Object.entries(p)) {
      if (key === "detail") {
        if (value?.kind === "hit") {
          const hitKey = `${value.hit.requestId}:${value.hit.fullHash}`;
          hitCache.current.set(`${rangeKey}:${hitKey}`, value.hit);
          if (hitCache.current.size > 200) hitCache.current.delete(hitCache.current.keys().next().value);
        }
        next.detailKey = value?.kind === "value" ? value.key : null;
        next.detailHit = value?.kind === "hit" ? `${value.hit.requestId}:${value.hit.fullHash}` : null;
        changed = true; navigation = true;
      } else if (keys.includes(key)) {
        next[key] = value; changed = true;
        if (["tab", "view", "session", "at", "range"].includes(key)) navigation = true;
      } else rest[key] = value;
    }
    Object.assign(next, clearPromptLandingOnNavigation(pendingUrl.current, next));
    if (Object.keys(rest).length) setLocal((u) => ({ ...u, ...rest }));
    if (!changed) return;
    if ("q" in p) setSearchInput(p.q);
    pendingUrl.current = next;
    const go = () => {
      const params = serialiseUrlState(pendingUrl.current, new URLSearchParams(window.location.search));
      const query = params.toString();
      const current = new URLSearchParams(window.location.search).toString();
      if (query === current) return;
      const writes = ownSearchWrites.current;
      writes.set(query, (writes.get(query) || 0) + 1);
      router[navigation ? "push" : "replace"](`${window.location.pathname}${query ? `?${query}` : ""}`, { scroll: false });
    };
    clearTimeout(searchTimer.current);
    if ("q" in p && !navigation) searchTimer.current = setTimeout(go, 300); else go();
  }, [router, rangeKey]);
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    const el = document.documentElement, sync = () => setTheme(el.classList.contains("dark") ? "dark" : "light");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  const fileRef = useRef(null), loadCtl = useRef(null), loadSeqRef = useRef(0);
  const showToast = useCallback((nextToast) => {
    clearTimeout(toastTimerRef.current);
    setToast(nextToast);
    if (nextToast) toastTimerRef.current = setTimeout(() => setToast(null), 8000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  // A new load aborts the one in flight, so a slow old range never overwrites a newer one.
  const load = useCallback(async (reason = "poll") => {
    loadCtl.current?.abort();
    const ctl = (loadCtl.current = new AbortController());
    const seq = ++loadSeqRef.current;
    // First load or new range: show the cached summary at once, then revalidate.
    const hit = reason === "range" || reason === "initial" ? cacheGet(summaryKey(rangeKey)) : null;
    if (hit) { loadedKeyRef.current = rangeKey; setLoadedSummary({ key: rangeKey, data: hit.data }); setMode("ready"); }
    setRefreshReason(reason);
    const { from, to } = bounds(range);
    try {
      const d = await call(`/api/pii-guard?from=${Math.round(from)}&to=${Math.round(to)}`, null, ctl.signal);
      if (ctl.signal.aborted || seq !== loadSeqRef.current) return;
      loadedKeyRef.current = rangeKey;
      cacheSet(summaryKey(rangeKey), d);
      setLoadedSummary({ key: rangeKey, data: d });
      setMode("ready");
      setErrorText("");
      setPollSeq((n) => n + 1);
    } catch (e) {
      if (ctl.signal.aborted || seq !== loadSeqRef.current) return;
      setErrorText(e.message || "Request failed");
      setMode("error");
    } finally {
      if (seq === loadSeqRef.current) setRefreshReason(null);
    }
  }, [range, rangeKey]);
  // Poll every 30 s while the tab is visible. The next poll starts after the last one ends; a hidden tab
  // stops polling and reloads when it is shown again.
  useEffect(() => {
    let t, gen = 0, off = false; // `gen`: only the newest tick schedules the next one, so chains never double up
    const initialReason = loadedKeyRef.current === null ? "initial" : loadedKeyRef.current !== rangeKey ? "range" : "poll";
    const tick = async (reason = "poll") => { clearTimeout(t); const g = ++gen; if (document.visibilityState !== "visible") return; await load(reason); if (!off && g === gen) t = setTimeout(() => tick("poll"), 30e3); };
    const onVis = () => { if (document.visibilityState === "visible") tick("poll"); else clearTimeout(t); };
    tick(initialReason);
    document.addEventListener("visibilitychange", onVis);
    return () => { off = true; clearTimeout(t); loadCtl.current?.abort(); document.removeEventListener("visibilitychange", onVis); };
  }, [load, rangeKey]);

  // Event log: 50 events per page, newest first, flattened to one row per hit. The server applies the
  // client, model, source and action filters. The 30 s refresh reloads only the newest page.
  const evFilter = `&client=${encodeURIComponent(ui.fClient)}&model=${encodeURIComponent(ui.fModel)}&source=${ui.fSource}&action=${ui.fAction}&group=${encodeURIComponent(ui.fGroup)}&q=${encodeURIComponent(dq0)}${ui.tests ? "&tests=1" : ""}`;
  const fetchEvents = useCallback(async (cursor, signal) => {
    const { from, to } = bounds(range);
    const cur = cursor ? `&before=${cursor.before}&skip=${cursor.skip}` : "";
    const { events = [], next = null } = await call(`/api/pii-guard?events=1&limit=50&from=${Math.round(from)}&to=${Math.round(to)}${cur}${evFilter}`, null, signal);
    return { rows: eventRows(events), next };
  }, [range, evFilter]);
  // The newest page follows `pollSeq` (background polls / range loads), not config-only updates; older pages load once.
  const evTick = evNewest ? pollSeq : null;
  useEffect(() => {
    if ((ui.tab !== "findings" || ui.view !== "hit") && !urlState.detailHit) return;
    const ctl = new AbortController();
    const key = evRequestKey;
    setEventData({ key, status: "loading", rows: [], next: null });
    fetchEvents(evCursor, ctl.signal).then(({ rows, next }) => setEventData({ key, status: "success", rows, next }))
      .catch(() => { if (!ctl.signal.aborted) setEventData({ key, status: "error", rows: [], next: null }); });
    return () => ctl.abort();
  }, [ui.tab, ui.view, urlState.detailHit, evTick, evCursor, fetchEvents, evRequestKey]);
  useEffect(() => {
    if (!urlState.detailHit || !hitCacheKey) return;
    const cached = hitCache.current.get(hitCacheKey);
    if (cached) {
      setHitLookup({ key: hitCacheKey, status: "success", hit: cached });
      return;
    }
    const ctl = new AbortController();
    setHitLookup({ key: hitCacheKey, status: "loading", hit: null });
    const { from, to } = bounds(range);
    const [requestId, fullHash] = urlState.detailHit.split(":");
    const lookup = async () => {
      let cursor = null, pageCount = 0;
      try {
        while (!ctl.signal.aborted) {
          const cur = cursor ? `&before=${cursor.before}&skip=${cursor.skip}` : "";
          const { events = [], next = null } = await call(`/api/pii-guard?events=1&limit=200&tests=1&q=${encodeURIComponent(fullHash)}&from=${Math.round(from)}&to=${Math.round(to)}${cur}`, null, ctl.signal);
          pageCount++;
          const found = eventRows(events).find((row) => row.requestId === requestId && row.fullHash === fullHash);
          if (found) {
            hitCache.current.set(hitCacheKey, found);
            setHitLookup({ key: hitCacheKey, status: "success", hit: found });
            return;
          }
          cursor = nextHitLookupCursor({ pageCount, next });
          if (!cursor) break;
        }
        if (!ctl.signal.aborted) setHitLookup({ key: hitCacheKey, status: "missing", hit: null });
      } catch {
        if (!ctl.signal.aborted) setHitLookup({ key: hitCacheKey, status: "error", hit: null });
      }
    };
    lookup();
    return () => ctl.abort();
  }, [urlState.detailHit, hitCacheKey, range, rangeKey]);
  useEffect(() => {
    if (!urlState.detailKey) return;
    const found = (data?.summary?.groups || []).some((v) => `${v.hash}:${v.rule}` === urlState.detailKey);
    const missingValue = shouldDropMissingDetail({ currentKey: rangeKey, loadedKey: loadedSummary.key, succeeded: mode === "ready", found });
    if (!missingValue) return;
    const next = { ...pendingUrl.current, detailKey: null };
    pendingUrl.current = next;
    const query = serialiseUrlState(next, new URLSearchParams(window.location.search)).toString();
    const writes = ownSearchWrites.current;
    writes.set(query, (writes.get(query) || 0) + 1);
    router.replace(`${window.location.pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }, [data, loadedSummary.key, mode, rangeKey, urlState, router]);
  const setEvPage = (update) => setEvPageState({ key: eventsFilterKey, list: update(evPage) });
  const loadOlder = evNext && !evBusy ? () => { setEvPage((p) => [...p, { cursor: evNext }]); set({ sel: {} }); } : null;
  const loadNewer = !evNewest && !evBusy ? () => { setEvPage((p) => p.slice(0, -1)); set({ sel: {} }); } : null;
  const loadNewest = !evNewest && !evBusy ? () => { setEvPage(() => []); set({ sel: {} }); } : null;

  useEffect(() => { call("/api/pii-guard?samples=1").then((s) => setSamples(Array.isArray(s) ? s : [])).catch(() => {}); }, []);

  // Text test runs as the user types.
  const testId = useRef(0);
  useEffect(() => {
    if (ui.tab !== "test" || ui.testKind !== "text") return;
    const id = ++testId.current; // ignore responses from older inputs
    const t = setTimeout(() => {
      call("/api/pii-guard", { test: ui.testText, testMode: ui.testMode === "current" ? undefined : ui.testMode, testWhere: ui.testWhere })
        .then((r) => { if (id === testId.current) setTest((x) => ({ ...x, result: r, error: "" })); }).catch((e) => { if (id === testId.current) setTest((x) => ({ ...x, error: e.message })); });
    }, 300);
    return () => clearTimeout(t);
  }, [ui.tab, ui.testKind, ui.testText, ui.testMode, ui.testWhere]);
  // Image test: a sample, or the uploaded file.
  const ocrOn = !!data?.health?.ocr?.available && data?.config?.ocr?.mode !== "off";
  useEffect(() => {
    if (ui.tab !== "test" || ui.testKind !== "image" || !ocrOn) return;
    let off = false;
    const sample = samples[ui.imgSel];
    if (!ui.upload && !sample) return;
    const t = setTimeout(async () => {
      setTest((x) => ({ ...x, busy: true, image: null, error: "" }));
      try {
        const testImage = ui.upload ? { data: await toB64(ui.upload.file) } : { sample: sample.id };
        const r = await call("/api/pii-guard", { testImage });
        if (!off) setTest((x) => ({ ...x, image: r, busy: false }));
      } catch (e) { if (!off) setTest((x) => ({ ...x, error: e.message, busy: false })); }
    }, 0);
    return () => { off = true; clearTimeout(t); };
  }, [ui.tab, ui.testKind, ui.imgSel, ui.upload, samples, ocrOn]);

  // Saves a settings change, patches local config/summary in place when returned, or reloads current range.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const act = useCallback(async (body, toast, undo, meta = {}) => {
    const opKey = meta.opKey || (meta.target ? `op:${meta.target}` : `op:${++opSeqRef.current}`);
    if (pendingOpsRef.current[opKey]) return false;
    const seq = ++opSeqRef.current;
    const nextPending = { ...pendingOpsRef.current, [opKey]: { seq, target: meta.target || null, optimistic: meta.optimistic || null } };
    pendingOpsRef.current = nextPending;
    setPendingOps(nextPending);
    setErrorToast(null);
    let ok = false;
    let needsReload = false;
    try {
      const res = await call("/api/pii-guard", body);
      ok = true;
      if (dataRef.current && res?.config) {
        const nextConfig = res.config;
        setLoadedSummary((prev) => {
          if (!prev?.data) return prev;
          const prevIgnore = JSON.stringify(prev.data.config?.ignore || []);
          const nextIgnore = JSON.stringify(nextConfig.ignore || []);
          const nextSummary = prevIgnore !== nextIgnore && prev.data.summary
            ? applyIgnoreToSummary(prev.data.summary, nextConfig.ignore || [])
            : prev.data.summary;
          const nextOcr = nextConfig.ocr && prev.data.health?.ocr
            ? {
                ...prev.data.health.ocr,
                mode: nextConfig.ocr.quality || prev.data.health.ocr.quality || prev.data.health.ocr.mode,
                quality: nextConfig.ocr.quality || prev.data.health.ocr.quality,
                enabled: Boolean(prev.data.health.ocr.available && nextConfig.ocr.mode !== "off"),
              }
            : prev.data.health?.ocr;
          return {
            ...prev,
            data: {
              ...prev.data,
              config: nextConfig,
              summary: nextSummary,
              ...(nextOcr ? { health: { ...prev.data.health, ocr: nextOcr } } : {}),
            },
          };
        });
      } else {
        needsReload = true;
      }
      if (toast) showToast({ id: seq, text: toast, undo });
    } catch (e) {
      setErrorToast({ id: seq, text: e?.message || "Could not save setting." });
    } finally {
      if (pendingOpsRef.current[opKey]?.seq === seq) {
        const cleaned = { ...pendingOpsRef.current };
        delete cleaned[opKey];
        pendingOpsRef.current = cleaned;
        setPendingOps(cleaned);
      }
    }
    if (needsReload) {
      await loadRef.current("save");
    }
    return ok;
  }, [showToast]);

  const fit = null;
  // Typing in the search box updates the input at once; the filtered list follows at lower priority.
  const dq = useDeferredValue(ui.q);
  const vui = useMemo(() => (dq === ui.q ? ui : { ...ui, q: dq }), [ui, dq]);
  const v = useMemo(() => data && buildView({ data, ui: vui, set, act, range, fit, test, events: { ...eventRowsAll, rows: rawEvents }, samples, pendingOps }), [data, vui, set, act, range, fit, test, rawEvents, eventRowsAll, samples, pendingOps]);

  const isLoading = mode === "loading" || (!v && mode !== "error"), isError = mode === "error";
  const isRefreshing = isRefreshingState({ hasData: Boolean(data), mode, refreshReason });
  const preset = range.preset, customLabel = range.label || "";
  const onRange = (r) => set({ range: r, sel: {}, detail: null, pending: null, page: 0, leakPage: 0 });
  const todayKey = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const retry = () => { setMode("loading"); load(data ? "manual" : "initial"); };
  const openConsole = () => router.push("/dashboard/console-log");
  const toast = toastState?.text;
  const undo = async () => {
    const u = toastState?.undo;
    if (!u || undoPending) return;
    setUndoPending(true);
    try {
      const ok = await act(u, null, null, { opKey: `undo:${toastState.id}` });
      if (ok) showToast(null);
    } finally {
      setUndoPending(false);
    }
  };
  const dismissToast = () => showToast(null);
  const dismissError = () => setErrorToast(null);
  const setFile = (file, name) => { if (file && file.type.startsWith("image/") && file.size <= 10 * 1024 * 1024) set({ upload: { file, name: name || file.name, url: URL.createObjectURL(file) } }); };
  const onFile = (e) => setFile(e.target.files?.[0]);
  const onDragOver = (e) => e.preventDefault();
  const onDrop = (e) => { e.preventDefault(); setFile(e.dataTransfer.files?.[0]); };
  const onPaste = (e) => setFile([...(e.clipboardData.files || [])].find((x) => x.type.startsWith("image/")), "pasted image");
  const vRef = useRef(null), gRef = useRef(null), fRef = useRef(null);
  const [fade, setFade] = useState({ v: false, g: false });
  const checkFade = useCallback(() => {
    const f = (el) => !!el && el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    const next = { v: f(vRef.current), g: f(gRef.current) };
    setFade((p) => (p.v === next.v && p.g === next.g ? p : next));
  }, []);
  // Re-observe only when the tab or sub-tab changes, the only times the two scrollers mount or unmount.
  useEffect(() => {
    checkFade();
    const ro = new ResizeObserver(checkFade);
    [vRef.current, gRef.current].forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
  }, [ui.tab, ui.view, mode, checkFade]);
  // Free the previous upload preview when it is replaced or the page closes.
  const uploadUrl = ui.upload?.url;
  useEffect(() => () => { if (uploadUrl) URL.revokeObjectURL(uploadUrl); }, [uploadUrl]);
  const mask = (on) => (on ? "linear-gradient(to right,#000 calc(100% - 40px),transparent)" : "none");
  const maskV = mask(fade.v), maskG = mask(fade.g), maskF = "none", fWrap = "wrap", fOverflow = "visible";
  const S = v?.s || {};
  const s = { header: true, leaks: S.leaks, numbers: S.numbers, bygroup: S.bygroup, where: S.where, wording: S.wording, mode: S.mode, groups: S.groups, values: S.values, test: S.test, health: S.health, ocr: S.ocr && v?.okScanner };
  const empty = {};
  const { rangeShort = "", status = { text: "Loading…", c: "var(--tx2)", bg: "var(--seg)" }, tabs = [], goLeaks, goHealth, leaks = [], noLeaks, leakCount, leakBorder, leakIcon, dismissAll, dismissAllPending, n = empty, cards = [], sumNote, byGroup = [], trendTitle, fbars = [], fgap, locs = [], toggleLoc, locBtn, byClient = [],
    redactRules, globalBtns = [], modePending, piiEx, ocrRows = [], groups = [], viewBtns = [], isValues, isEvents, isPrompts, isSessions, shownLabel, groupOpts = [], clientOpts = [], modelOpts = [], hasSel, selCount, allSel, toggleAll,
    bulkAllow, bulkAllowPending, values = [], noValues, hits = [], noHits, allowedCount = 0, showAllowed, toggleAllowed, allowed = [], detail, prevValues, nextValues, prevLeaks, nextLeaks, leakPageLabel, samples: sampleBtns = [], kindBtns = [], isText, isImage, testSegs = [], imgSegs = [], testHits = [], noTestHits,
    noHitsText, testVerdict = empty, testOut, thumbs = [], hasUpload, hasSample, imgBg, imgName, sampleName, sampleBg, problems = [], metrics = [], ocrStats = [], healthNote, ocrNote, imgGroups = [], health = empty } = v || {};
  const drawerDetail = detail || (urlState.detailHit && !(urlState.at && urlState.view === "prompt") ? { missingHit: true, hitStatus: hit ? "loading" : hitStatus, close: () => set({ detail: null }) } : null);
  // A filter change clears the selection, so bulk actions never hit hidden rows.
  const filt = (k) => (e) => set({ [k]: e.target.value, sel: {}, page: 0 });
  const q = ui.q, onQ = filt("q"), fGroup = ui.fGroup, onGroup = filt("fGroup"), fAction = ui.fAction, onAction = filt("fAction");
  const fClient = ui.fClient, onClient = filt("fClient"), onTests = (e) => set({ tests: e.target.checked, sel: {}, page: 0 });
  const fModel = ui.fModel, onModel = filt("fModel"), fSource = ui.fSource, onSource = filt("fSource");
  const clearSel = () => set({ sel: {} });
  const closeMenu = useCallback(() => set({ menu: null }), [set]);
  const moreBtn = { alignSelf: "center", marginTop: "10px", height: "28px", padding: "0 12px", borderRadius: "7px", border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: "12px", cursor: "pointer" };
  // Value chips in the conversation: linked only when the summary still holds the finding in range.
  const chipsOf = useCallback((hash) => {
    const g = (data?.summary?.groups || []).find((v) => v.hash === hash);
    if (!g) return { linked: false, open: undefined, preview: "", action: "" };
    const actions = Array.isArray(g.actions) ? g.actions : [];
    const a = g.ignored ? "allowed" : actions.includes("leaked") ? "leaked" : g.action;
    return { linked: true, preview: g.preview, action: ALABEL[a] || a[0].toUpperCase() + a.slice(1), open: () => set({ detail: { kind: "value", key: `${hash}:${g.rule}` } }) };
  }, [data, set]);
  const testText = ui.testText, onTest = (e) => set({ testText: e.target.value }), testMode = ui.testMode, onTestMode = (e) => set({ testMode: e.target.value });
  const testWhere = ui.testWhere, onTestWhere = (e) => set({ testWhere: e.target.value });

  return (
    <div data-r9={theme} className="r9-pii-root" style={{ display: "flex", flexDirection: "column", minHeight: "100%", overflowX: "clip", backgroundColor: "var(--bg)", backgroundImage: "linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px)", backgroundSize: "44px 44px", color: "var(--tx)", fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", fontSize: "13px", lineHeight: "1.4" }}>
      <style>{`
        @keyframes r9spin{to{transform:rotate(360deg)}}
        [data-r9].r9-pii-root{overflow-x:clip}
        [data-r9].r9-pii-root .r9-range-root{position:relative;max-width:100%;min-width:0}
        [data-r9].r9-pii-root .r9-pii-status{white-space:normal;height:auto;min-height:28px;padding:5px 12px;line-height:1.35;text-align:left;max-width:100%}
        [data-r9].r9-pii-root .r9-pii-cards button{white-space:normal;min-width:0}
        [data-r9].r9-pii-root .r9-pii-prompt-btn{white-space:normal}
        [data-r9].r9-pii-root .r9-pii-thumbs button{white-space:normal;line-height:1.15}
        [data-r9].r9-pii-root .r9-pii-toast-wrap{position:fixed;right:20px;bottom:20px;z-index:90;display:flex;flex-direction:column;gap:8px;max-width:min(440px,calc(100vw - 32px));pointer-events:none}
        [data-r9].r9-pii-root .r9-pii-toast-wrap>*{pointer-events:auto}
        @media(max-width:600px){
          [data-r9].r9-pii-root .r9-pii-pad{padding-left:16px!important;padding-right:16px!important}
          [data-r9].r9-pii-root .r9-pii-toast-wrap{left:16px;right:16px;bottom:16px;max-width:none}
          [data-r9].r9-pii-root .r9-pii-cards{grid-template-columns:repeat(2,minmax(0,1fr))!important}
          [data-r9].r9-pii-root .r9-pii-leak-actions{grid-column:auto!important;justify-content:flex-start!important}
          [data-r9].r9-pii-root .r9-pii-loc-row{grid-template-columns:minmax(100px,1.2fr) 1fr auto!important;gap:8px!important}
          [data-r9].r9-pii-root .r9-pii-client-row{grid-template-columns:minmax(84px,1.2fr) minmax(24px,1fr) 52px 72px!important;gap:8px!important}
          [data-r9].r9-pii-root .r9-pii-ocr-row{grid-template-columns:1fr!important;gap:8px!important}
          [data-r9].r9-pii-root .r9-pii-thumbs{grid-template-columns:repeat(3,minmax(0,1fr))!important}
          [data-r9].r9-pii-root .r9-pii-problem-row{grid-template-columns:auto 1fr!important}
          [data-r9].r9-pii-root .r9-pii-problem-cta{grid-column:2}
        }
      `}</style>
  <div style={{ display: "flex", alignItems: "stretch", flex: "1", minWidth: "0" }}>
  <main style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", position: "relative" }}>
    {(s.header) && (<>
      <div className="r9-pii-pad" style={{ padding: "16px 32px 12px", display: "flex" }}><button onClick={goLeaks} className="r9-pii-status" style={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "28px", padding: "5px 12px", borderRadius: "14px", border: "0", background: status.bg, color: status.c, font: "inherit", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "normal", textAlign: "left", maxWidth: "100%" }}><span style={{ width: "8px", height: "8px", borderRadius: "50%", background: status.c, flexShrink: 0 }}></span><span>{status.text}</span></button></div>
      <div className="r9-pii-pad" style={{ position: "sticky", top: "0", zIndex: "30", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", padding: "8px 32px", background: "var(--bg)", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", gap: "2px", flexWrap: "wrap" }}>
          {(tabs).map((t, _i) => (<Fragment key={_i}>
            <button onClick={t.on} style={t.style}>{t.label}{(t.count) && (<><span style={{ fontSize: "11px", fontWeight: "600", padding: "0 6px", borderRadius: "9px", background: "var(--seg)", color: "var(--tx2)" }}>{t.count}</span></>)}{(t.dot) && (<><span style={{ width: "7px", height: "7px", borderRadius: "50%", background: t.dot }}></span></>)}</button>
          </Fragment>))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: "0", maxWidth: "100%" }}>
          <RangeBar preset={preset} customLabel={customLabel} onChange={onRange} today={todayKey} />
        </div>
      </div>
    </>)}

    <RefreshBar on={isRefreshing} label="Refreshing PII Guard data" />
    <div className="r9-pii-pad" aria-busy={isRefreshing || undefined} style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "16px 32px 48px", minWidth: "0" }}>
      {(isLoading) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}><div style={{ width: "120px", height: "12px", borderRadius: "6px", background: "var(--seg)" }} className="r9-shimmer"></div><div style={{ height: "40px", borderRadius: "8px", background: "var(--seg)" }} className="r9-shimmer"></div><div style={{ height: "40px", borderRadius: "8px", background: "var(--seg)" }} className="r9-shimmer"></div></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "16px" }}><div style={{ height: "200px", borderRadius: "12px", background: "var(--card)", border: "1px solid var(--line)" }}></div><div style={{ height: "200px", borderRadius: "12px", background: "var(--card)", border: "1px solid var(--line)" }}></div></div>
        <div style={{ color: "var(--tx3)", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "16px" }}>hourglass_top</span>Reading the PII Guard event log…</div>
      </>)}
      {(isError) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", padding: "56px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", textAlign: "center" }}>
          <span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "36px", color: "var(--red)" }}>error</span>
          <div style={{ fontSize: "16px", fontWeight: "600" }}>Could not load PII Guard</div>
          <div style={{ color: "var(--tx2)", maxWidth: "480px", textWrap: "pretty" }}>{errorText} Requests still pass through (fail open).</div>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}><button style={{ height: "32px", padding: "0 14px", borderRadius: "8px", border: "0", background: "var(--acc)", color: "#fff", font: "inherit", fontWeight: "600", cursor: "pointer" }} onClick={retry}>Retry</button><button style={{ height: "32px", padding: "0 14px", borderRadius: "8px", border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", cursor: "pointer" }} onClick={openConsole}>Open Console Log</button></div>
        </div>
      </>)}

      {(s.leaks) && (<>
        <div style={{ background: "var(--card)", border: `1px solid ${leakBorder}`, borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", paddingBottom: "8px" }}><div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: "0" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "19px", color: status.c }}>{leakIcon}</span><span style={{ fontWeight: "600", fontSize: "14px" }}>Couldn&apos;t redact</span><span style={{ color: "var(--tx3)", fontSize: "12px" }}>The rule says Redact, but these values sat where they cannot be changed, so they were sent as is</span></div><span style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--tx3)" }}>{leakCount}{dismissAll && <button onClick={dismissAll} disabled={dismissAllPending} aria-busy={dismissAllPending || undefined} style={btnSt(btn, dismissAllPending)}>{dismissAllPending ? <><Spinner />Saving…</> : "Dismiss all"}</button>}</span></div>
          {(leaks).map((l) => (<Fragment key={l.key}>
            <div style={{ borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: "6px", padding: "10px 0" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: "8px 16px", alignItems: "center" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" }}><span style={{ display: "flex", gap: "8px", alignItems: "baseline", minWidth: "0" }}><span style={{ fontWeight: "600" }}>{l.rule}</span>{l.preview && <span style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--tx2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.preview}</span>}</span><span style={{ fontSize: "11.5px", color: "var(--tx3)" }}>{l.group} · <span style={{ fontFamily: "var(--mono)" }}>#{l.hash}</span> · {l.time}</span></div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}><span title={l.tip} style={badgeSt("var(--redbg)", "var(--red)")}>{l.tag}</span><span style={{ fontSize: "12px", color: "var(--tx2)" }}>{l.loc}</span></div>
                <div className="r9-pii-leak-actions" style={{ display: "flex", gap: "8px", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", gridColumn: "span 2" }}>
                  <button onClick={l.view} title="Open details and the stored prompt" style={btn}>View</button>
                  <button onClick={l.dismiss} disabled={l.dismissPending} aria-busy={l.dismissPending || undefined} title="Hide this row. It comes back if the value shows up somewhere new." style={btnSt(btn, l.dismissPending)}>{l.dismissPending ? <><Spinner />Saving…</> : "Dismiss"}</button>
                  <button onClick={l.allow} disabled={l.allowPending} aria-busy={l.allowPending || undefined} title="This one value is never redacted or blocked again" style={btnSt(btn, l.allowPending)}>{l.allowPending ? <><Spinner />Saving…</> : "Mark as safe"}</button>
                  <span style={{ fontSize: "11.5px", color: "var(--tx3)" }}>All {l.ruleName}:</span>
                  <div style={segWrap}>{l.ruleBtns.map((b) => <button key={b.label} onClick={b.on} disabled={b.disabled} aria-busy={b.pending || undefined} style={b.style}>{b.pending && <Spinner />}{b.label}</button>)}</div>
                  {l.rulePending && <span role="status" style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Saving…</span>}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 6px", fontSize: "11.5px", color: "var(--tx3)" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "14px" }}>person</span><span>{l.client}</span><span>·</span><span style={{ fontFamily: "var(--mono)" }}>{l.model}</span></div>
              {(l.why) && <div style={{ fontSize: "11.5px", color: "var(--tx2)", display: "flex", gap: "6px", alignItems: "flex-start" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "15px", color: "var(--amber)" }}>info</span>{l.why}</div>}
              {(l.pending) && <Confirm p={l.pending} />}
            </div>
          </Fragment>))}
          {(prevLeaks || nextLeaks) && (<div style={{ display: "flex", gap: "8px", justifyContent: "center", alignItems: "center", paddingTop: "8px", fontSize: "12px", color: "var(--tx3)" }}>
            <button onClick={prevLeaks || undefined} disabled={!prevLeaks} style={moreBtn}>Previous</button>
            <span>{leakPageLabel}</span>
            <button onClick={nextLeaks || undefined} disabled={!nextLeaks} style={moreBtn}>Next</button>
          </div>)}
          {(noLeaks) && (<>
            <div style={{ borderTop: "1px solid var(--line)", padding: "26px 0 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", textAlign: "center" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "30px", color: "var(--green)" }}>verified</span><span style={{ fontWeight: "600" }}>Nothing to review in this range</span><span style={{ color: "var(--tx3)", fontSize: "12px" }}>Every value with a Redact or Block rule was replaced or stopped before sending.</span></div>
          </>)}
        </div>
      </>)}

      {(s.numbers) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", gap: "28px", flexWrap: "wrap", alignItems: "stretch", minWidth: "0" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "min(100%,300px)", flex: "0 1 340px" }}>
            <div className="r9-pii-cards" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
              {cards.map((c) => (<button key={c.label} onClick={c.on} title={c.title} style={{ textAlign: "left", border: "0", borderRadius: "8px", background: "var(--seg)", padding: "8px 10px", font: "inherit", color: "var(--tx)", cursor: "pointer", display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" }}>
                <span style={{ fontSize: "11px", color: "var(--tx2)", fontWeight: "600", letterSpacing: ".04em", textTransform: "uppercase" }}>{c.label}</span>
                <span style={{ fontSize: "20px", fontWeight: "650", color: c.c, fontVariantNumeric: "tabular-nums" }}>{c.value}</span>
                <span style={{ fontSize: "11px", color: "var(--tx3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.sub}</span>
              </button>))}
            </div>
            <span style={{ fontSize: "11px", color: "var(--tx3)", fontVariantNumeric: "tabular-nums" }}>Counts are unique values. Found = Redacted + Observed + Blocked + Couldn&apos;t redact + Allowed ({sumNote}). Second line: requests (distinct turns). Hover a card for hits.</span>
          </div>
          <div style={{ flex: "1", minWidth: "min(100%,280px)", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)" }}>{trendTitle}</span>
              <div style={{ display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap", fontSize: "11.5px", color: "var(--tx2)" }}><span style={{ display: "flex", gap: "5px", alignItems: "center" }}><span style={{ width: "9px", height: "9px", borderRadius: "2px", background: "var(--acc)", opacity: ".75" }}></span>Findings</span><span style={{ display: "flex", gap: "5px", alignItems: "center" }}><span style={{ width: "9px", height: "9px", borderRadius: "50%", background: "var(--red)" }}></span>Couldn&apos;t redact</span>
                <button onClick={goHealth} style={{ display: "flex", alignItems: "center", gap: "6px", height: "24px", padding: "0 10px", borderRadius: "12px", border: "0", background: health.bg, color: health.c, font: "inherit", fontSize: "11.5px", fontWeight: "600", cursor: "pointer" }}><span style={{ width: "7px", height: "7px", borderRadius: "50%", background: health.c }}></span>{health.text}</button></div>
            </div>
            <div style={{ position: "relative", height: "150px", display: "flex", alignItems: "flex-end", gap: fgap, borderBottom: "1px solid var(--line2)", paddingTop: "14px" }}>
              {(fbars).map((b, _i) => (<Fragment key={_i}>
                <div style={{ flex: "1", minWidth: "0", height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", position: "relative" }}>
                  {(b.leak) && (<><span style={{ position: "absolute", top: "-12px", width: "9px", height: "9px", borderRadius: "50%", background: "var(--red)", border: "2px solid var(--card)" }}></span></>)}
                  <div title={b.title} style={{ width: "100%", height: b.h, background: "var(--acc)", opacity: b.op, borderRadius: "2px 2px 0 0" }}></div>
                </div>
              </Fragment>))}
            </div>
            <div style={{ display: "flex", gap: fgap }}>{(fbars).map((b, _i) => (<Fragment key={_i}><span style={{ flex: "1", minWidth: "0", fontSize: "10.5px", color: "var(--tx3)", whiteSpace: "nowrap" }}>{b.tick}</span></Fragment>))}</div>
          </div>
        </div>
      </>)}

      {(s.bygroup && byGroup.length > 0) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "8px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}><span style={{ fontWeight: "600", fontSize: "14px" }}>By rule group</span><span style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Unique values per group. Click a number to see those values.</span></div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(140px,1.2fr) minmax(120px,1fr) repeat(4,72px) 64px", gap: "8px 12px", alignItems: "center", minWidth: "640px", fontSize: "12.5px" }}>
              {["Group", "Split", "Redacted", "Observed", "Blocked", "Couldn't redact", "Total"].map((h, i) => <span key={i} style={{ fontSize: "11px", fontWeight: "600", color: "var(--tx3)", letterSpacing: ".04em", textAlign: i > 1 ? "right" : "left", textTransform: "uppercase" }}>{h}</span>)}
              {byGroup.map((g) => (<Fragment key={g.id}>
                <span>{g.name}</span>
                <Bar parts={g.bar} />
                {g.cells.map((c, i) => c.on ? <button key={i} onClick={c.on} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: c.c, textAlign: "right", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "2px", fontVariantNumeric: "tabular-nums" }}>{c.n}</button> : <span key={i} style={{ textAlign: "right", color: c.c, fontVariantNumeric: "tabular-nums" }}>{c.n}</span>)}
                <span style={{ textAlign: "right", fontWeight: "600", fontVariantNumeric: "tabular-nums" }}>{g.total}</span>
              </Fragment>))}
            </div>
          </div>
        </div>
      </>)}

      {(s.where) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}><span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)" }}>WHERE VALUES APPEARED</span><button onClick={toggleLoc} style={{ border: "0", background: "transparent", color: "var(--acc)", font: "inherit", fontSize: "12px", cursor: "pointer" }}>{locBtn}</button></div>
          {(locs).map((w, _i) => (<Fragment key={_i}>
            <div className="r9-pii-loc-row" style={{ display: "grid", gridTemplateColumns: "minmax(160px,220px) 1fr 90px", gap: "14px", alignItems: "center" }}>
              <span style={{ fontSize: "12.5px", minWidth: "0", overflowWrap: "anywhere" }}>{w.name}</span>
              <div style={{ height: "8px", borderRadius: "4px", background: "var(--seg)", overflow: "hidden" }}><div style={{ height: "100%", width: w.w, background: "var(--acc)", borderRadius: "4px" }}></div></div>
              <span style={{ textAlign: "right", fontSize: "12px", color: "var(--tx2)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{w.hits} hits</span>
            </div>
          </Fragment>))}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px", marginTop: "4px" }}>
            <div className="r9-pii-client-row" style={{ display: "grid", gridTemplateColumns: "minmax(100px,150px) 1fr 80px 104px", gap: "14px", fontSize: "11px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx3)" }}><span>BY CLIENT</span><span></span><span style={{ textAlign: "right" }}>VALUES</span><span style={{ textAlign: "right" }} title="Values the rule said to redact that could not be changed">NOT REDACTED</span></div>
            {(byClient).map((c, _i) => (<Fragment key={_i}>
              <div className="r9-pii-client-row" style={{ display: "grid", gridTemplateColumns: "minmax(100px,150px) 1fr 80px 104px", gap: "14px", alignItems: "center", fontSize: "12.5px" }}>
                <span style={{ display: "flex", flexDirection: "column", minWidth: "0" }}><span style={{ overflowWrap: "anywhere" }}>{c.name}</span><span style={{ fontSize: "11px", color: "var(--tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.sub}</span></span>
                <div style={{ height: "6px", borderRadius: "3px", background: "var(--seg)", overflow: "hidden" }}><div style={{ height: "100%", width: c.w, background: "var(--tx3)", borderRadius: "3px", opacity: ".6" }}></div></div>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.values}</span>
                <span style={{ textAlign: "right", fontWeight: "600", fontVariantNumeric: "tabular-nums", color: c.lc }}>{c.leaks}</span>
              </div>
            </Fragment>))}
          </div>
        </div>
      </>)}

      {(s.wording) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}><span style={{ fontWeight: "600", fontSize: "14px" }}>Default action</span><span style={{ fontSize: "12px", color: "var(--tx2)" }}>Used by every rule group set to Default. {redactRules} rules override it with Redact.</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              {modePending && <span role="status" style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Saving…</span>}
              <div style={segWrap}>{(globalBtns).map((g, _i) => (<Fragment key={_i}><button onClick={g.on} disabled={g.disabled} aria-busy={g.pending || undefined} style={g.style}>{g.pending && <Spinner />}{g.label}</button></Fragment>))}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "8px" }}>
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "var(--seg)", display: "flex", flexDirection: "column", gap: "3px" }}><span style={{ fontWeight: "600", fontSize: "12px" }}>Off</span><span style={{ fontSize: "11.5px", color: "var(--tx2)" }}>Not scanned at all.</span></div>
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "var(--bluebg)", display: "flex", flexDirection: "column", gap: "3px" }}><span style={{ fontWeight: "600", fontSize: "12px", color: "var(--blue)" }}>Observe</span><span style={{ fontSize: "11.5px", color: "var(--tx2)" }}>Logged only. The model gets the real value.</span></div>
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "var(--acc2)", display: "flex", flexDirection: "column", gap: "3px" }}><span style={{ fontWeight: "600", fontSize: "12px", color: "var(--acc)" }}>Redact</span><span style={{ fontSize: "11.5px", color: "var(--tx2)" }}>The model gets <span style={{ fontFamily: "var(--mono)" }}>{piiEx}</span> instead of the value.</span></div>
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "var(--violetbg)", display: "flex", flexDirection: "column", gap: "3px" }}><span style={{ fontWeight: "600", fontSize: "12px", color: "var(--violet)" }}>Block</span><span style={{ fontSize: "11.5px", color: "var(--tx2)" }}>First time a value appears, the request is stopped (HTTP 400). After that it is redacted.</span></div>
          </div>
        </div>
      </>)}

      {(s.mode) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", paddingBottom: "8px" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "19px", color: "var(--tx2)" }}>image_search</span><span style={{ fontWeight: "600", fontSize: "14px" }}>Images (OCR)</span><span style={{ fontSize: "12px", color: "var(--tx3)" }}>Text inside images is logged only. Images are never changed.</span></div>
          {(ocrRows).map((o, _i) => (<Fragment key={_i}>
            <div className="r9-pii-ocr-row" style={{ display: "grid", gridTemplateColumns: "140px auto 1fr", gap: "16px", alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <span style={{ fontWeight: "600", fontSize: "12.5px" }}>{o.label}</span>
              <div style={{ justifySelf: "start", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>{(o.hasBtns) && (<><div style={segWrap}>{(o.btns).map((g, _i) => (<Fragment key={_i}><button onClick={g.on} disabled={g.disabled} aria-busy={g.pending || undefined} style={g.style}>{g.pending && <Spinner />}{g.label}</button></Fragment>))}</div>{o.pending && <span role="status" style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Saving…</span>}</>)}{(o.ro) && (<><span style={{ display: "inline-flex", alignItems: "center", gap: "5px", height: "28px", padding: "0 10px", borderRadius: "8px", border: "1px dashed var(--line2)", color: "var(--tx2)", fontSize: "12px" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "15px" }}>lock</span>{o.ro}</span></>)}</div>
              <span style={{ fontSize: "12px", color: "var(--tx2)" }}>{o.desc}</span>
            </div>
          </Fragment>))}
        </div>
      </>)}

      {(s.groups) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", paddingBottom: "8px" }}><span style={{ fontWeight: "600", fontSize: "14px" }}>Rule groups</span><span style={{ fontSize: "12px", color: "var(--tx3)" }}>Unique values in {rangeShort}, by action</span></div>
          <div ref={gRef} onScroll={checkFade} style={{ overflowX: "auto", WebkitMaskImage: maskG, maskImage: maskG }}>{(groups).map((g, _i) => (<Fragment key={_i}>
            <div style={{ borderTop: "1px solid var(--line)", minWidth: "700px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "24px minmax(150px,1fr) 170px 150px auto", gap: "12px", alignItems: "center", padding: "10px 0" }}>
                <button onClick={g.toggle} aria-label={g.open ? `Collapse ${g.name}` : `Expand ${g.name}`} style={{ border: "0", background: "transparent", color: "var(--tx2)", cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: "18px", padding: "0" }}>{g.chev}</button>
                <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}><span style={{ fontWeight: "600" }}>{g.name}</span><span style={{ fontSize: "11.5px", color: "var(--tx3)" }}>{g.ruleCount} {g.ruleCount === 1 ? "rule" : "rules"}{g.pending ? " · Saving…" : ""}</span></div>
                <span style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--tx2)", fontVariantNumeric: "tabular-nums" }}><Bar parts={g.bar} /><span style={{ minWidth: "32px", textAlign: "right" }}>{g.total}</span></span>
                <span>{(g.differs) && (<><span style={{ fontSize: "10.5px", fontWeight: "600", padding: "2px 7px", borderRadius: "5px", background: "var(--amberbg)", color: "var(--amber)" }}>{g.badge}</span></>)}</span>
                <div style={segWrap}>{(g.btns).map((b, _i) => (<Fragment key={_i}><button onClick={b.on} disabled={b.disabled} aria-busy={b.pending || undefined} style={b.style}>{b.pending && <Spinner />}{b.label}</button></Fragment>))}</div>
              </div>
              {(g.open) && (<>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: "6px", padding: "0 0 12px 36px" }}>
                  {(g.rules).map((r, _i) => (<Fragment key={_i}><div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "7px 10px", borderRadius: "7px", background: "var(--seg)", fontSize: "12px" }}><span style={{ display: "flex", justifyContent: "space-between" }}><span>{r.name}</span><span style={{ color: "var(--tx3)", fontVariantNumeric: "tabular-nums" }}>{r.total}</span></span><Bar parts={r.bar} /></div></Fragment>))}
                </div>
              </>)}
            </div>
          </Fragment>))}</div>
        </div>
      </>)}

      {(s.values) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px", display: "flex", flexDirection: "column", gap: "8px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <div style={segWrap}>{viewBtns.map((g) => <button key={g.label} onClick={g.on} style={g.style}>{g.label}</button>)}</div>
            <span style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "12px", color: "var(--tx3)" }}>
              <button onClick={toggleAllowed} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "var(--acc)", cursor: "pointer" }}>Marked safe ({allowedCount})</button>
              <span>{shownLabel}</span>
            </span>
          </div>
          {(showAllowed) && (<div style={{ padding: "8px 16px", borderRadius: "8px", background: "var(--seg)", display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
            <span style={{ color: "var(--tx2)", padding: "4px 0" }}>Values marked safe are never redacted or blocked, under any rule. Choose Scan again to undo.</span>
            {allowed.map((x) => <div key={x.hash} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", borderTop: "1px solid var(--line)", padding: "4px 0" }}><span style={{ minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name} <span style={{ fontFamily: "var(--mono)", color: "var(--tx3)" }}>{x.preview}</span></span><button onClick={x.restore} disabled={x.restorePending} aria-busy={x.restorePending || undefined} style={btnSt(btn, x.restorePending)}>{x.restorePending ? <><Spinner />Saving…</> : "Scan again"}</button></div>)}
            {allowed.length === 0 && <span style={{ color: "var(--tx3)", padding: "4px 0" }}>No values are marked safe.</span>}
          </div>)}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px", minWidth: "0", display: "flex", alignItems: "center", gap: "6px", height: "32px", padding: "0 8px", border: "1px solid var(--line2)", borderRadius: "8px", background: "var(--card)" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "17px", color: "var(--tx3)" }}>search</span><input value={q} onChange={onQ} placeholder={isPrompts ? "Words in the prompt, e.g. repeat this" : "Rule, masked value, model, client or hash"} style={{ border: "0", outline: "none", background: "transparent", color: "var(--tx)", font: "inherit", flex: "1", minWidth: "0" }} /></div>
            <select value={fGroup} onChange={onGroup} style={selSt}><option value="">All groups</option>{groupOpts.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
            <select value={fAction} onChange={onAction} style={selSt}><option value="">All actions</option><option value="redact">Redacted</option><option value="observe">Observed</option><option value="block">Blocked</option><option value="leaked">Couldn&apos;t redact</option><option value="allowed">Marked safe</option></select>
            <select value={fSource} onChange={onSource} style={selSt}><option value="">All sources</option><option value="text">Text</option><option value="ocr">OCR</option></select>
            <select value={fClient} onChange={onClient} style={selSt}><option value="">All clients</option>{clientOpts.map((o) => <option key={o}>{o}</option>)}</select>
            <select value={fModel} onChange={onModel} style={selSt}><option value="">All models</option>{modelOpts.map((o) => <option key={o}>{o}</option>)}</select>
            {(isEvents) && <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px", color: "var(--tx2)", whiteSpace: "nowrap" }}><input type="checkbox" checked={ui.tests} onChange={onTests} />Include Test tab runs</label>}
          </div>
          {(hasSel) && (<div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "8px", borderRadius: "8px", background: "var(--tx)", color: "var(--bg)" }}>
            <span style={{ fontWeight: "600", fontSize: "12.5px", padding: "0 8px" }}>{selCount} selected</span>
            <button onClick={bulkAllow} disabled={bulkAllowPending} aria-busy={bulkAllowPending || undefined} style={btnSt(darkBtn, bulkAllowPending)}>{bulkAllowPending ? <><Spinner />Saving…</> : "Mark as safe"}</button>
            <button onClick={clearSel} disabled={bulkAllowPending} style={{ ...btnSt(darkBtn, bulkAllowPending), marginLeft: "auto", background: "transparent" }}>Clear</button>
          </div>)}
          <div ref={vRef} onScroll={checkFade} style={{ overflowX: "auto", WebkitMaskImage: maskV, maskImage: maskV }}>{(isValues) && (<>
            <div style={{ ...rowGrid(VCOLS), fontSize: "11px", fontWeight: "600", color: "var(--tx3)", letterSpacing: ".04em", padding: "4px 0" }}><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /><span>VALUE</span><span>BECAME</span><span>ACTION</span><span style={{ textAlign: "right" }}>REQUESTS</span><span>LAST SEEN</span><span>CLIENT</span><span></span></div>
            {(values).map((v) => (<Fragment key={v.key}>
              <div style={{ ...rowGrid(VCOLS), padding: "8px 0", borderTop: "1px solid var(--line)", background: v.bg, position: "relative" }}>
                <input type="checkbox" checked={v.sel} onChange={v.toggle} aria-label={`Select ${v.name}`} />
                <button onClick={v.view} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "var(--tx)", textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.preview}</span>
                  <span style={{ fontSize: "11px", color: "var(--tx3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.name} · {v.group}{v.ocr ? " · OCR" : ""}</span>
                </button>
                <span title={v.became} style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--tx2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.became}</span>
                <span style={badgeSt(v.abg, v.ac)}>{v.action}</span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: "12px" }}>{v.reqs}</span>
                <span style={{ fontSize: "12px", color: "var(--tx2)", whiteSpace: "nowrap" }}>{v.last}</span>
                <span style={{ fontSize: "12px", color: "var(--tx2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.client}</span>
                <button onClick={v.openMenu} aria-label="Row actions" aria-expanded={v.menu} style={{ ...btn, padding: "0", width: "28px", fontFamily: "'Material Symbols Outlined'", fontSize: "18px" }}>more_horiz</button>
                {(v.menu) && <RowMenu v={v} close={closeMenu} />}
              </div>
              {(v.pending) && <div style={{ padding: "0 0 8px 32px" }}><Confirm p={v.pending} /></div>}
            </Fragment>))}
            {(noValues) && (<><div style={{ padding: "32px 0", textAlign: "center", color: "var(--tx3)" }}>No values match these filters.</div></>)}
            {(prevValues || nextValues) && (<div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
              <button onClick={prevValues || undefined} disabled={!prevValues} style={moreBtn}>Previous {PAGE}</button>
              <button onClick={nextValues || undefined} disabled={!nextValues} style={moreBtn}>Next {PAGE}</button>
            </div>)}
          </>)}
          {(isEvents) && (<>
            <div style={{ ...rowGrid(HCOLS), fontSize: "11px", fontWeight: "600", color: "var(--tx3)", letterSpacing: ".04em", padding: "4px 0" }}><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /><span>TIME</span><span>VALUE</span><span>ACTION</span><span>WHERE</span><span>CLIENT</span><span>MODEL</span><span>REQUEST</span><span></span></div>
            {(hits).map((e) => (<Fragment key={e.id}>
              <div style={{ ...rowGrid(HCOLS), padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: "12px", background: e.bg }}>
                <input type="checkbox" checked={e.sel} onChange={e.toggle} aria-label={`Select ${e.rule}`} />
                <span style={{ color: "var(--tx2)", fontVariantNumeric: "tabular-nums" }}>{e.t}</span>
                <span style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" }}><span style={{ fontFamily: "var(--mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.preview || `#${e.hash}`}</span><span style={{ fontSize: "11px", color: "var(--tx3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.rule}{e.test ? " · test" : ""}</span></span>
                <span style={badgeSt(e.abg, e.ac)}>{e.action}</span>
                <span style={{ color: "var(--tx2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.loc}</span>
                <span style={{ color: "var(--tx2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.client}</span>
                <span title={e.model} style={{ fontFamily: "var(--mono)", fontSize: "11.5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.model}</span>
                <span title={e.requestId} style={{ fontFamily: "var(--mono)", fontSize: "11.5px", color: "var(--tx3)" }}>{e.req}</span>
                <button onClick={e.view} style={btn}>View</button>
              </div>
            </Fragment>))}
            {(noHits && !evBusy) && (<div style={{ padding: "32px 0", textAlign: "center", color: "var(--tx3)" }}>No hits match these filters.</div>)}
            <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
              {(loadNewest) && (<button onClick={loadNewest} style={moreBtn}>Newest</button>)}
              {(loadNewer) && (<button onClick={loadNewer} style={moreBtn}>Newer 50</button>)}
              {(loadOlder) && (<button onClick={loadOlder} style={moreBtn}>Older 50</button>)}
            </div>
          </>)}
          {(isPrompts) && <Prompts q={dq0} session={ui.session} at={ui.at} mark={(data?.summary?.groups || []).find((v) => `${v.hash}:${v.rule}` === ui.detailKey)?.preview || ""} range={range} tick={pollSeq} clearSession={() => set({ session: "", at: "", detail: null })} setSession={(id) => set({ session: id, at: "", q: "" })} />}
          {(isSessions && !ui.session) && <SessionsList ui={ui} sessData={sessData} sessReady={sessReady} openSession={(id) => set({ session: id, at: "", q: "" })} />}
          {ui.view === "session" && ui.session && <Conversation sessionId={ui.session} at={ui.at} mark={(data?.summary?.groups || []).find((x) => `${x.hash}:${x.rule}` === ui.detailKey)?.preview || ""} range={range} onBack={() => set({ session: "", at: "" })} set={set} chipsOf={chipsOf} />}</div>
        </div>
      </>)}

      {(s.test) && (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,400px),1fr))", gap: "16px", alignItems: "stretch", minWidth: "0" }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px", minWidth: "0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}><span style={{ fontWeight: "600", fontSize: "14px" }}>Input</span><div style={segWrap}>{(kindBtns).map((g, _i) => (<Fragment key={_i}><button onClick={g.on} style={g.style}>{g.label}</button></Fragment>))}</div></div>
            {(isText) && (<>
            <textarea value={testText} onChange={onTest} style={{ width: "100%", boxSizing: "border-box", minHeight: "180px", resize: "vertical", border: "1px solid var(--line2)", borderRadius: "9px", padding: "12px", background: "var(--bg)", color: "var(--tx)", fontFamily: "var(--mono)", fontSize: "12.5px", lineHeight: "1.6", outline: "0" }}></textarea>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}><span style={{ fontSize: "12px", color: "var(--tx3)" }}>Try an example</span>{(sampleBtns).map((x, _i) => (<Fragment key={_i}><button onClick={x.on} style={{ height: "26px", padding: "0 10px", borderRadius: "13px", border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: "11.5px", cursor: "pointer" }}>{x.label}</button></Fragment>))}</div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11.5px", color: "var(--tx2)", maxWidth: "100%" }}>Test with<select value={testMode} onChange={onTestMode} style={{ height: "32px", flex: "none", border: "1px solid var(--line2)", borderRadius: "8px", background: "var(--card)", color: "var(--tx)", font: "inherit", padding: "0 8px", minWidth: "150px", maxWidth: "100%" }}><option value="current">Current rules</option><option value="redact">Every rule on Redact</option></select></label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11.5px", color: "var(--tx2)", maxWidth: "100%" }}>Where<select value={testWhere} onChange={onTestWhere} style={{ height: "32px", flex: "none", border: "1px solid var(--line2)", borderRadius: "8px", background: "var(--card)", color: "var(--tx)", font: "inherit", padding: "0 8px", minWidth: "150px", maxWidth: "100%" }}><option value="user">User · text</option><option value="tool_result">User · tool result</option><option value="assistant">Assistant · text</option><option value="system">System</option><option value="thinking">Model reasoning (signed)</option></select></label>
            </div>
            </>)}
            {(isImage) && (<>
              <div tabIndex={0} onPaste={onPaste} onDrop={onDrop} onDragOver={onDragOver} style={{ minHeight: "190px", border: "1.5px dashed var(--line2)", borderRadius: "9px", background: "var(--bg)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px", padding: "12px", outline: "0", boxSizing: "border-box" }}>
                {(hasUpload) && (<><div style={{ width: "100%", height: "140px", borderRadius: "6px", background: imgBg }}></div><span style={{ fontSize: "11.5px", color: "var(--tx3)" }}>{imgName}</span></>)}
                {(hasSample) && (<><div style={{ width: "100%", height: "120px", borderRadius: "6px", background: sampleBg }} title={sampleName}></div><div style={{ fontFamily: "var(--mono)", fontSize: "11.5px", color: "var(--tx2)" }}>sample: {sampleName}</div></>)}
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", justifyContent: "center", fontSize: "12px", color: "var(--tx2)" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "18px" }}>add_photo_alternate</span>Drop or paste (⌘V) an image here, or<button type="button" onClick={() => fileRef.current?.click()} style={{ border: "0", padding: "0", background: "transparent", color: "var(--acc)", font: "inherit", fontWeight: "600", cursor: "pointer" }}>choose a file</button><input ref={fileRef} type="file" accept="image/*" onChange={onFile} hidden /></div>
              </div>
              <div className="r9-pii-thumbs" style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", gap: "6px" }}>{(thumbs).map((t, _i) => (<Fragment key={_i}><button onClick={t.on} title={t.name} style={t.style}>{t.short}</button></Fragment>))}</div>
              <div style={{ fontSize: "11.5px", color: "var(--tx3)", display: "flex", gap: "6px", alignItems: "center" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "15px" }}>visibility</span>Images are never changed. What OCR finds is logged only.</div>
            </>)}
          </div>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px", minWidth: "0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}><span style={{ fontWeight: "600", fontSize: "14px" }}>Result</span><span style={{ fontSize: "11.5px", fontWeight: "600", padding: "2px 8px", borderRadius: "5px", background: testVerdict.bg, color: testVerdict.c }}>{testVerdict.text}</span></div>
            {(isText) && (<><div style={{ padding: "12px", borderRadius: "9px", border: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: "12.5px", lineHeight: "1.75", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{(testSegs).map((x, _i) => (<Fragment key={_i}><span style={x.st}>{x.t}</span></Fragment>))}</div></>)}
            {(isImage) && (<><div style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)" }}>OCR TEXT</span><div style={{ padding: "12px", borderRadius: "9px", border: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: "12.5px", lineHeight: "1.75", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{(imgSegs).map((x, _i) => (<Fragment key={_i}><span style={x.st}>{x.t}</span></Fragment>))}</div></div></>)}
            <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
              {(testHits).map((h, _i) => (<Fragment key={_i}><div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "10px", alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: "12px" }}><span><b>{h.rule}</b> <span style={{ color: "var(--tx3)" }}>· {h.group}</span></span><span style={{ fontFamily: "var(--mono)", color: "var(--tx3)", fontSize: "11px" }}>#{h.hash}</span><span style={{ fontSize: "11px", fontWeight: "600", padding: "2px 7px", borderRadius: "5px", background: h.abg, color: h.ac }}>{h.action}</span></div></Fragment>))}
              {(noTestHits) && (<><div style={{ padding: "10px 0", color: "var(--tx3)", fontSize: "12px", borderTop: "1px solid var(--line)" }}>{noHitsText}</div></>)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)" }}>WHAT THE MODEL RECEIVES</span><div style={{ padding: "12px", borderRadius: "9px", background: "var(--seg)", fontFamily: "var(--mono)", fontSize: "12.5px", lineHeight: "1.7", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{testOut}</div></div>
          </div>
        </div>
      </>)}

      {(s.health) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}><div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "19px", color: "var(--amber)" }}>warning</span><span style={{ fontWeight: "600", fontSize: "14px" }}>Problems</span></div><span style={{ fontSize: "12px", color: "var(--tx3)" }}>{healthNote}</span></div>
          {(problems).map((p, _i) => (<Fragment key={_i}>
            <div className="r9-pii-problem-row" style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "12px", alignItems: "center", padding: "10px 12px", borderRadius: "9px", background: p.bg }}>
              <span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "18px", color: p.c }}>{p.icon}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" }}><span style={{ fontWeight: "600" }}>{p.title}</span><span style={{ fontSize: "12px", color: "var(--tx2)" }}>{p.desc}</span></div>
              <span className="r9-pii-problem-cta">{(p.cta) && (<><button onClick={p.onCta} disabled={p.ctaPending} aria-busy={p.ctaPending || undefined} style={btnSt(btn, p.ctaPending)}>{p.ctaPending ? <><Spinner />Saving…</> : p.cta}</button></>)}</span>
            </div>
          </Fragment>))}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: "8px" }}>
            {(metrics).map((m, _i) => (<Fragment key={_i}>
              <div style={{ background: "var(--seg)", borderRadius: "8px", padding: "9px 12px", display: "flex", flexDirection: "column", gap: "1px" }}><span style={{ fontSize: "11px", color: "var(--tx3)" }}>{m.label}</span><span style={{ fontWeight: "600", fontVariantNumeric: "tabular-nums", color: m.c }}>{m.value}</span><span style={{ fontSize: "11px", color: "var(--tx3)" }}>{m.sub}</span></div>
            </Fragment>))}
          </div>
        </div>
      </>)}

      {(s.ocr) && (<>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px", minWidth: "0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}><div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "19px", color: "var(--tx2)" }}>image_search</span><span style={{ fontWeight: "600", fontSize: "14px" }}>Images (OCR)</span></div><span style={{ fontSize: "12px", color: "var(--tx3)" }}>{ocrNote}</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: "8px" }}>
            {(ocrStats).map((m, _i) => (<Fragment key={_i}>
              <div style={{ background: "var(--seg)", borderRadius: "8px", padding: "9px 12px", display: "flex", flexDirection: "column", gap: "1px" }}><span style={{ fontSize: "11px", color: "var(--tx3)" }}>{m.label}</span><span style={{ fontWeight: "600", fontVariantNumeric: "tabular-nums" }}>{m.value}</span><span style={{ fontSize: "11px", color: "var(--tx3)" }}>{m.sub}</span></div>
            </Fragment>))}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)", paddingBottom: "6px" }}>RECENT IMAGES</span>
            {(imgGroups).map((g, _i) => (<Fragment key={_i}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 72px minmax(0,1.4fr)", gap: "12px", alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: "12px" }}>
                <span style={{ display: "flex", flexDirection: "column", gap: "1px", minWidth: "0" }}><span style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{g.model}</span><span style={{ color: "var(--tx3)", fontSize: "11px" }}>{g.when}</span></span>
                <span style={{ fontWeight: "600" }}>{g.count}</span>
                <span style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", minWidth: "0" }}><span style={{ fontSize: "10.5px", fontWeight: "600", padding: "1px 6px", borderRadius: "4px", background: g.bg, color: g.c }}>{g.status}</span><span style={{ color: "var(--tx2)" }}>{g.detail}</span></span>
              </div>
            </Fragment>))}
          </div>
        </div>
      </>)}
    </div>
  </main>
  </div>
      {(toast || errorToast) && (
        <div className="r9-pii-toast-wrap">
          {errorToast && (
            <div role="alert" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "10px", background: "var(--redbg)", border: "1px solid var(--red)", color: "var(--tx)", fontSize: "12.5px", boxShadow: "var(--shadow)" }}>
              <span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "18px", color: "var(--red)", flexShrink: 0 }}>error</span>
              <span style={{ flex: "1", minWidth: "0", overflowWrap: "anywhere" }}>{errorToast.text}</span>
              <button onClick={dismissError} aria-label="Dismiss error" style={{ border: "0", background: "transparent", color: "var(--tx2)", cursor: "pointer", padding: "2px", fontFamily: "'Material Symbols Outlined'", fontSize: "17px", lineHeight: 1 }}>close</button>
            </div>
          )}
          {toast && (
            <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "10px", background: "var(--tx)", color: "var(--bg)", fontSize: "12.5px", boxShadow: "0 10px 28px rgba(0,0,0,.22)" }}>
              <span style={{ flex: "1", minWidth: "0", overflowWrap: "anywhere" }}>{toast}</span>
              {toastState?.undo && (
                <button onClick={undo} disabled={undoPending} aria-busy={undoPending || undefined} style={{ border: "0", background: "transparent", color: "var(--acc)", font: "inherit", fontWeight: "600", cursor: undoPending ? "not-allowed" : "pointer", opacity: undoPending ? 0.65 : 1, display: "inline-flex", alignItems: "center", gap: "5px", whiteSpace: "nowrap" }}>
                  {undoPending && <Spinner />}{undoPending ? "Undoing…" : "Undo"}
                </button>
              )}
              <button onClick={dismissToast} aria-label="Dismiss notification" style={{ border: "0", background: "transparent", color: "var(--bg)", opacity: 0.75, cursor: "pointer", padding: "2px", fontFamily: "'Material Symbols Outlined'", fontSize: "17px", lineHeight: 1 }}>close</button>
            </div>
          )}
        </div>
      )}
      {(drawerDetail) && <Drawer d={drawerDetail} />}
    </div>
  );
}

// Shared bits. Inline styles match the rest of the page (design: PII Guard.dc.html, round 17).
const btn = { height: "28px", padding: "0 10px", borderRadius: "7px", border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "5px" };
const darkBtn = { height: "26px", padding: "0 10px", borderRadius: "6px", border: "0", background: "rgba(127,127,127,.25)", color: "inherit", font: "inherit", fontSize: "12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "5px" };
const btnSt = (base, disabled) => (disabled ? { ...base, opacity: 0.6, cursor: "not-allowed" } : base);
function Spinner({ size = 12 }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: "50%", border: "1.75px solid currentColor", borderRightColor: "transparent", display: "inline-block", flexShrink: 0, animation: "r9spin .65s linear infinite" }} />;
}
const segWrap = { display: "flex", gap: "2px", padding: "3px", borderRadius: "9px", background: "var(--seg)" };
// Native select with its own chevron 8px after the text, so a long model name never pushes it far right.
const CHEV = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E\")";
const selSt = { height: "32px", flex: "none", maxWidth: "180px", textOverflow: "ellipsis", appearance: "none", WebkitAppearance: "none", border: "1px solid var(--line2)", borderRadius: "8px", backgroundColor: "var(--card)", backgroundImage: CHEV, backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center", color: "var(--tx)", font: "inherit", fontSize: "12.5px", padding: "0 26px 0 8px", cursor: "pointer" };
const badgeSt = (bg, c) => ({ justifySelf: "start", display: "inline-flex", alignItems: "center", height: "20px", fontSize: "11px", fontWeight: "600", padding: "0 8px", borderRadius: "5px", background: bg, color: c, whiteSpace: "nowrap" });
const VCOLS = "24px minmax(180px,1.6fr) minmax(140px,1.1fr) 88px 72px 80px minmax(96px,.8fr) 32px";
const HCOLS = "24px 64px minmax(150px,1.3fr) 88px minmax(140px,1.1fr) minmax(96px,.8fr) minmax(110px,.9fr) 80px 56px";
const rowGrid = (cols) => ({ display: "grid", gridTemplateColumns: cols, gap: "8px", alignItems: "center", minWidth: "880px" });

function Bar({ parts }) {
  return <div style={{ display: "flex", height: "8px", borderRadius: "4px", background: "var(--seg)", overflow: "hidden", flex: "1", minWidth: "80px" }}>{parts.map((p, i) => <div key={i} title={p.title} style={{ width: p.w, background: p.color }} />)}</div>;
}

function Confirm({ p }) {
  return (
    <div role="alertdialog" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "8px 12px", borderRadius: "8px", background: "var(--amberbg)", fontSize: "12px", color: "var(--tx)" }}>
      <span style={{ flex: "1 1 240px" }}>{p.text}</span>
      <button onClick={p.cancel} style={btn}>Cancel</button>
      <button onClick={p.ok} style={{ ...btn, height: "auto", minHeight: "28px", padding: "5px 10px", whiteSpace: "normal", textAlign: "left", border: "0", background: "var(--acc)", color: "#fff", fontWeight: "600" }}>Rule for every value of this type</button>
    </div>
  );
}

function RowMenu({ v, close }) {
  const ref = useRef(null);
  // Light dismiss, same as the range calendar.
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target)) close(); };
    const key = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [close]);
  const item = { border: "0", background: "transparent", textAlign: "left", padding: "6px 10px", borderRadius: "6px", font: "inherit", fontSize: "12.5px", color: "var(--tx)", cursor: "pointer" };
  return (
    <div ref={ref} role="menu" style={{ position: "absolute", right: "0", top: "100%", zIndex: 40, width: "220px", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: "10px", boxShadow: "0 12px 32px rgba(40,20,10,.16)", padding: "4px", display: "flex", flexDirection: "column" }}>
      <button role="menuitem" style={item} onClick={() => { close(); v.view(); }}>View details</button>
      <button role="menuitem" disabled={v.allowPending} aria-busy={v.allowPending || undefined} style={btnSt(item, v.allowPending)} onClick={() => { close(); v.allow(); }}>{v.allowPending ? "Saving…" : v.allowLabel}</button>
      <span style={{ padding: "6px 10px 2px", fontSize: "11px", color: "var(--tx3)" }}>All {v.name}:</span>
      <div style={{ ...segWrap, margin: "2px 6px 6px" }}>{v.ruleBtns.map((b) => <button key={b.label} role="menuitem" disabled={b.disabled} aria-busy={b.pending || undefined} onClick={() => { close(); b.on(); }} style={b.style}>{b.pending && <Spinner />}{b.label}</button>)}</div>
    </div>
  );
}

// Sessions list: one card per session; a session ID search box plus advanced filters in a disclosure.
function SessionsList({ ui, sessData, sessReady, openSession }) {
  const [advOpen, setAdvOpen] = useState(false);
  const rows = ui.view === "session" && sessReady ? sessData.rows : [];
  const running = sessData.key && sessData.status === "loading";
  const sf = ui.sf;
  const textInput = { height: "30px", maxWidth: "220px", flex: "1 1 160px", minWidth: "0", border: "1px solid var(--line2)", borderRadius: "8px", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: "12px", padding: "0 10px" };
  const filtersActive = sf.client || sf.provider || sf.combo || sf.hash || sf.findings;
  return <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
    {running && <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--tx3)" }}><Spinner size={12} />Loading sessions…</div>}
    {sessReady && sessData.status === "error" && <div style={{ display: "flex", gap: "8px", alignItems: "center", padding: "10px", borderRadius: "8px", background: "var(--redbg)", fontSize: "12px", color: "var(--tx)" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "16px", color: "var(--red)" }}>error</span>Session list is unavailable. <span style={{ color: "var(--tx2)" }}>Requests without findings are not affected.</span></div>}
    {(sessReady && !rows.length) && <div style={{ padding: "32px 0", textAlign: "center", color: "var(--tx3)" }}>{ui.q || filtersActive ? "No sessions match these filters." : "No stored sessions in this range yet. Prompts are kept 14 days."}</div>}
    {rows.map((r, i) => {
      const card = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px", cursor: "pointer" };
      return <div key={r.sessionId} role="button" tabIndex={0} onClick={() => openSession(r.sessionId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSession(r.sessionId); } }} style={{ ...card, ...(i % 2 ? { background: "var(--bg)" } : {}) }} onDoubleClick={undefined}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap", alignItems: "baseline" }}>
          <span style={{ display: "flex", gap: "8px", alignItems: "baseline", minWidth: "0", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: "12px" }}>{String(r.sessionId).slice(0, 12)}…</span>
            <span style={{ fontSize: "11.5px", color: "var(--tx2)" }}>{stamp(new Date(Number(r.first)).toISOString())} → {age(new Date(Number(r.last)).toISOString())}</span>
          </span>
          <button onClick={(e) => { e.stopPropagation(); openSession(r.sessionId); }} style={btn}>Open</button>
        </div>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "11.5px", color: "var(--tx2)", justifyContent: "flex-start" }}>
          <span>Client <b style={{ color: "var(--tx)" }}>{r.client || "Not recorded"}</b></span>
          <span>Route <span style={{ fontFamily: "var(--mono)" }}>{r.combo || r.model || "Not recorded"}</span></span>
          <span>Provider <b style={{ color: "var(--tx)" }}>{r.provider || "Not recorded"}</b></span>
          <span>Requests <b style={{ color: "var(--tx)", fontVariantNumeric: "tabular-nums" }}>{r.requests}</b></span>
          <span>Unique values <b style={{ color: r.values ? "var(--acc)" : "var(--tx)", fontVariantNumeric: "tabular-nums" }}>{r.values}</b></span>
          <span>Text <b style={{ color: r.hasText ? "var(--green)" : "var(--tx3)" }}>{r.hasText ? "Stored" : "Events only"}</b></span>
        </div>
      </div>;
    })}
  </div>;
}
// One conversation: oldest-first stored messages grouped by first captured request, a sticky finding
// navigator, and per-message markers. `at` is a stored message id to land and open.
function Conversation({ sessionId, at, mark, range, onBack, set, chipsOf }) {
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [onlyFound, setOnlyFound] = useState(false);
  const [surround, setSurround] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [copied, setCopied] = useState(false);
  const [nav, setNav] = useState(0);
  // Memoized so the fetch effect can list them without an exhaustive-deps warning:
  // same values as `bounds(range)`, but stable across unrelated re-renders.
  const { from, to } = useMemo(() => bounds(range), [range]);
  const key = `${sessionId}|${Math.round(from)}|${Math.round(to)}`;
  useEffect(() => {
    const ctl = new AbortController();
    // Reset before the async fetch: caller-owned reset, not external sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading", data: null, error: "" });
    call(`/api/pii-guard/sessions?sessionId=${encodeURIComponent(sessionId)}&from=${Math.round(from)}&to=${Math.round(to)}`, null, ctl.signal)
      .then((d) => { if (!ctl.signal.aborted) setState({ status: "ok", data: d, error: d.unavailable ? "Prompt store unavailable on this server." : "" }); })
      .catch(() => { if (!ctl.signal.aborted) setState({ status: "error", data: null, error: "Could not load this session. Retry from Sessions." }); });
    return () => ctl.abort();
    // from/to come from the memoized bounds above; `key` covers both plus the session id.
  }, [key, from, to, sessionId]);
  const data = state.data;
  const groups = useMemo(() => data?.messages ? groupMessages(data.messages.rows) : [], [data]);
  const flat = useMemo(() => groups.flatMap((g) => g.messages), [groups]);
  const markers = useMemo(() => findingMarkers(flat), [flat]);
  // Deep link: `at` opens and scrolls to its message once rendered; a shown notice if it has expired.
  const target = useRef(null), jumped = useRef("");
  const [invalidAt, setInvalidAt] = useState(false);
  // Reset the deep-link bookkeeping when the target or session key changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { jumped.current = ""; setInvalidAt(false); }, [at, key]);
  useEffect(() => {
    if (!at || jumped.current === at || !data) return;
    const found = flat.some((m) => String(m.id) === at);
    if (!found) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded((u) => ({ ...u, [at]: true }));
    const t = setTimeout(() => { setInvalidAt(false); target.current?.scrollIntoView({ block: "center" }); jumped.current = at; }, 0);
    return () => clearTimeout(t);
  }, [at, data, flat]);
  useEffect(() => { if (at && jumped.current === at && !flat.some((m) => String(m.id) === at)) setInvalidAt(true); }, [flat, at]);
  // Mark at most the marker containing the drawer's chosen value; navigation steps between markers.
  const perMessage = useMemo(() => {
    const map = new Map();
    for (const m of markers) { if (!map.has(m.id)) map.set(m.id, []); map.get(m.id).push(m); }
    return map;
  }, [markers]);
  const g0 = groups[0]?.messages?.[0] || {};
  const routeSet = new Set(flat.map((m) => `${m.combo || m.model || ""}`).filter(Boolean));
  const hidden = useMemo(() => {
    const set2 = new Set();
    if (!onlyFound || !markers.length) return set2;
    const keep = new Set(markers.map((m) => m.messageIndex));
    if (surround) for (const k of [...keep]) { keep.add(k - 1); keep.add(k + 1); }
    flat.forEach((_, i) => { if (!keep.has(i)) set2.add(i); });
    return set2;
  }, [onlyFound, surround, markers, flat]);
  const shownGroups = onlyFound ? groups.map((g) => ({ ...g, messages: g.messages.filter((m) => !hidden.has(m._index)) })).filter((g) => g.messages.length) : groups;
  const navIdx = Math.max(0, Math.min(nav, Math.max(0, markers.length - 1)));
  const goNav = (d) => setNav((v) => Math.max(0, Math.min(v + d, markers.length - 1)));
  // Navigation opens the target's collapsed content and scrolls to it; findings order, not ids.
  const navTarget = useRef(new Map()), navSeen = useRef(-1);
  const navRefFor = (m) => (markers[navIdx]?.id === String(m.id) ? (el) => { if (el) navTarget.current.set(String(m.id), el); } : undefined);
  useEffect(() => {
    const mk = markers[navIdx];
    if (!mk) return;
    if (navSeen.current !== navIdx) setExpanded((u) => ({ ...u, [mk.id]: true }));
    navSeen.current = navIdx;
    const t = setTimeout(() => navTarget.current.get(mk.id)?.scrollIntoView({ block: "center", behavior: "smooth" }), 0);
    return () => clearTimeout(t);
  }, [navIdx, markers]);
  if (state.status === "loading") return <div style={{ padding: "24px 0", textAlign: "center", color: "var(--tx3)" }}><span style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}><Spinner size={12} />Reading the stored conversation…</span></div>;
  if (state.status === "error") return <div style={{ padding: "24px 0", textAlign: "center", color: "var(--tx3)" }}>{state.error}</div>;
  if (data?.notFound) return <div style={{ padding: "24px 0", textAlign: "center", color: "var(--tx3)" }}>This session has no stored text in this range. Events stay 90 days; text is kept 14 days. A missing message does not prove no findings.</div>;
  if (!data) return null;
  return <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={onBack} style={btn}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "15px" }}>arrow_back</span>Back to Sessions</button>
        <span style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: "13px" }}>{String(sessionId).slice(0, 12)}…</span>
        <button onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1500); try { navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?tab=findings&view=session&session=${encodeURIComponent(sessionId)}`); } catch {} }} style={btn} title="Copy a link to this conversation">{copied ? "Copied" : "Copy link"}</button>
      </div>
      <ConversationHeader data={data} g0={g0} routeSet={routeSet} />
      {invalidAt && <div style={{ color: "var(--tx3)", fontSize: "11.5px" }}>The linked message has expired. Text is kept 14 days.</div>}
      {data.messages.over > 0 && <div style={{ color: "var(--tx3)", fontSize: "11.5px" }}>Very long conversation: the newest {data.messages.over} stored messages beyond the size cap are not shown here; find them under Every hit.</div>}
      {data.messages.shown < data.messages.total && <div style={{ color: "var(--tx3)", fontSize: "11.5px" }}>Truncated: showing {data.messages.shown} of {data.messages.total} stored messages.</div>}
    </div>
    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", position: "sticky", top: "48px", zIndex: 20, background: "var(--card)", padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--line2)", boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
      {markers.length ? <>
        <span style={{ fontSize: "12px", fontWeight: 600 }} aria-live="polite">Finding {navIdx + 1} of {markers.length}</span>
        <button disabled={!navIdx} onClick={() => goNav(-1)} style={btnSt(btn, !navIdx)}>Previous</button>
        <button disabled={navIdx >= markers.length - 1} onClick={() => goNav(1)} style={btnSt(btn, navIdx >= markers.length - 1)}>Next</button>
      </> : <span style={{ fontSize: "12px", color: "var(--tx3)" }}>No finding markers in this range.</span>}
      <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" }}><input type="checkbox" checked={onlyFound} disabled={!markers.length} onChange={(e) => { setOnlyFound(e.target.checked); if (!e.target.checked) setSurround(false); }} />Only messages with findings</label>
      {onlyFound && <button onClick={() => setSurround((s) => !s)} style={btn}>{surround ? "Hide surrounding messages" : "Show surrounding messages"}</button>}
    </div>
    {shownGroups.map((g) => <Fragment key={`${g.requestId}|${g.n}`}>
      <div style={{ display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: ".05em", color: "var(--tx3)" }}>REQUEST {g.n}</span>
        <span style={{ fontSize: "11px", color: "var(--tx3)", fontFamily: "var(--mono)" }}>{g.messages[0] ? stamp(new Date(Number(g.messages[0].ts)).toISOString()) : ""}{g.messages[0]?.model ? ` · ${g.messages[0].model}` : ""}{g.messages[0]?.combo ? ` · ${g.messages[0].combo}` : ""}{g.messages[0]?.provider ? ` · ${g.messages[0].provider}` : ""}{g.messages[0]?.account ? ` · ${g.messages[0].account}` : ""}</span>
      </div>
      {g.messages.map((m) => <MessageRow key={m.id} m={m} at={at} targetRef={target}
        open={expanded[m.id] ?? !collapseDefault(m.role, m.kind, m.text)}
        toggle={() => setExpanded((u) => ({ ...u, [m.id]: !(expanded[m.id] ?? !collapseDefault(m.role, m.kind, m.text)) }))}
        set={set} chipsOf={chipsOf} mRef={navRefFor(m)} />)}
    </Fragment>)}
    {onlyFound && <span style={{ fontSize: "11px", color: "var(--tx3)" }}>Hidden context is collapsed but still counted in the header totals.</span>}
  </div>;
}

const MSG_ICON = { user: "person", assistant: "smart_toy", system: "settings", developer: "settings", tool: "output", other: "note" };
const MSG_LABEL = { user: "User", assistant: "Assistant", system: "System", developer: "Developer", tool: "Tool result" };
function MessageRow({ m, at, targetRef, open, toggle, set, chipsOf, mRef }) {
  const kind = m.kind === "tool_use" ? "tool" : m.kind === "tool_result" ? "result" : "prose";
  const isResult = kind === "result"; // kind wins over role: a user-role tool result is not user prose
  const label = isResult ? "Tool result" : MSG_LABEL[m.role] || m.role || "Message";
  void at; void open; void toggle; void set;
  const chips = (m.values || []).map((h) => ({ hash: h, ...chipsOf(h) }));
  const preview = String(m.text || "");
  const lines = preview.split("\n");
  const long = lines.length > PROSE_LINES || preview.length > 800;
  return <div ref={String(m.id) === at ? targetRef : mRef} style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
    <div style={{ padding: "8px 12px", borderRadius: "10px", border: "1px solid var(--line)", background: kind === "prose" && m.role === "user" ? "var(--acc2)" : kind === "prose" ? "var(--card)" : "var(--seg)", minWidth: 0 }}>
      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "17px", color: "var(--tx2)" }}>{MSG_ICON[kind === "tool" ? "assistant" : keyIcon(m)]}</span>
        <span style={{ fontWeight: 600, fontSize: "12px" }}>{label}</span>
        {kind === "tool" && <span style={{ fontFamily: "var(--mono)", fontSize: "11.5px", color: "var(--tx2)" }}>{m.tool || "tool call"}</span>}
        {isResult && m.tool && <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--tx3)" }}>{m.tool}</span>}
        {m.cut ? <span style={{ fontSize: "10.5px", fontWeight: 600, padding: "1px 6px", borderRadius: "4px", background: "var(--amberbg)", color: "var(--amber)" }}>Truncated</span> : null}
        {(chips.length) ? <span style={{ display: "inline-flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
          {chips.map((c) => <button key={c.hash} onClick={c.open} title={c.linked ? "Open finding details" : "No linked finding in this range; the value may no longer be active"} style={{ fontSize: "11px", fontWeight: 600, padding: "1px 7px", borderRadius: "5px", background: c.linked ? "var(--redbg)" : "var(--seg)", color: c.linked ? "var(--red)" : "var(--tx3)", border: 0, cursor: "pointer", font: "inherit" }}>{c.linked ? c.preview : `#${c.hash.slice(0, 6)}`}{c.linked && c.action ? ` · ${c.action}` : ""}</button>)}
        </span> : null}
      </div>
      {kind !== "prose" && m.tool && <div style={{ fontSize: "11px", color: "var(--tx3)", marginTop: "2px" }}>{kind === "tool" ? "Call" : "Result"} for <span style={{ fontFamily: "var(--mono)" }}>{m.tool}</span></div>}
      {kind === "tool" ? <div style={{ marginTop: "4px" }}><ToolArgs tool={m.tool} text={m.text} /></div>
        : !open && long ? <div style={{ fontSize: "12.5px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "7.8em", overflow: "hidden", opacity: 0.85 }}>{lines.slice(0, PROSE_LINES).join("\n")}</div>
        : <div style={{ fontSize: "12.5px", fontFamily: (m.role === "system" || m.role === "developer") ? "var(--mono)" : "inherit", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.text}</div>}
      {long && <button onClick={toggle} style={{ ...btn, alignSelf: "flex-start", height: "24px", padding: "0 8px", fontSize: "11px", marginTop: "4px" }}>{open ? "Show less" : "Show more"}</button>}
    </div>
  </div>;
}
const keyIcon = (m) => (m.kind === "tool_result" ? "output" : m.kind === "tool_use" ? "terminal" : m.role === "assistant" ? "smart_toy" : m.role === "system" || m.role === "developer" ? "settings" : "person");
// Stored tool call text is "Name {json…}": Bash commands become code, other parsed args become
// labeled fields, JSON as a whole sits under Structured data, and unparsable text falls back.
function ToolArgs({ tool, text }) {
  const [showJson, setShowJson] = useState(false);
  const f = toolFormat(tool, text);
  if (f.kind === "command") return <div style={{ fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7, maxHeight: "20em", overflow: "auto", padding: "8px 12px", borderRadius: "8px", background: "var(--card)", border: "1px solid var(--line2)", minHeight: 0 }}>{f.command}</div>;
  if (f.kind === "fields") return <>
    {!showJson && <div style={{ display: "grid", gap: "4px" }}>{f.fields.map((x, i) => <div key={i} style={{ display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap", minWidth: 0 }}><span style={{ fontSize: "11px", color: "var(--tx3)", minWidth: "80px" }}>{x.key}</span><span style={{ fontFamily: "var(--mono)", fontSize: "12px", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{x.value.length > 400 ? x.value.slice(0, 400) + "…" : x.value}</span></div>)}</div>}
    <button onClick={() => setShowJson((s) => !s)} style={{ ...btn, height: "22px", padding: "0 8px", fontSize: "11px" }}>{showJson ? "Hide structured data" : "Structured data"}</button>
    {showJson && <div style={{ fontFamily: "var(--mono)", fontSize: "11.5px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "16em", overflow: "auto", padding: "6px 10px", borderRadius: "8px", background: "var(--card)", border: "1px solid var(--line2)" }}>{String(text).replace(/^.*? /, "")}</div>}
  </>;
  if (f.kind === "fail") return <><div style={{ fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "8px 12px", borderRadius: "8px", background: "var(--card)", border: "1px solid var(--line2)" }}>{String(text || "")}</div><div style={{ fontSize: "11px", color: "var(--tx3)" }}>Cannot format arguments</div></>;
  return <div style={{ fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "8px 12px", borderRadius: "8px", background: "var(--card)", border: "1px solid var(--line2)" }}>{f.text}</div>;
}

function ConversationHeader({ data, g0, routeSet }) {
  const row = (label, value, mono) => <span style={{ display: "flex", gap: "5px", minWidth: 0 }}><span style={{ color: "var(--tx3)" }}>{label}</span><span style={{ ...(mono ? { fontFamily: "var(--mono)" } : {}), fontSize: "12px", overflowWrap: "anywhere" }}>{value || "Not recorded"}</span></span>;
  return <div style={{ padding: "10px 12px", borderRadius: "10px", background: "var(--card)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: "6px" }}>
    <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "12px" }}>
      {row("First seen", stamp(new Date(Number(data.first)).toISOString()) + " IST")}
      {row("Last seen", stamp(new Date(Number(data.last)).toISOString()) + " IST")}
      {row("Client", g0.client)}
      {row("Combo / model", g0.combo || g0.model, true)}
      {row("Resolved model", g0.resolvedModel || (g0.provider && g0.model ? `${g0.provider}/${g0.model}` : g0.model), true)}
      {row("Provider", g0.provider)}
      {row("Account", g0.account)}
      {row("Routes", routeSet.size > 1 ? "Multiple" : [...routeSet][0], true)}
      {row("Requests", String(data.requests ?? "—"))}
      {row("Stored messages", String(data.messages.total ?? "—"))}
      {row("Unique finding values", String(data.values ?? "—"))}
    </div>
    <div style={{ fontSize: "11.5px", color: "var(--amber)", display: "flex", gap: "6px", alignItems: "center" }}><span style={{ fontFamily: "'Material Symbols Outlined'", fontSize: "15px" }}>info</span>Stored request history, not a complete transcript. Response text is not stored; assistant text appears only when clients resend it.</div>
  </div>;
}
function Sec({ label, children }) {  return <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "11px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx3)", textTransform: "uppercase" }}>{label}</span>{children}</div>;
}
// Marks the masked value inside its masked context.
function highlight(text, mark) {
  const positions = occurrences(text, mark);
  if (!positions.length) return text;
  let end = 0;
  const parts = positions.map((at) => { const before = text.slice(end, at); end = at + mark.length; return <Fragment key={at}>{before}<mark data-match style={{ background: "var(--bluebg)", color: "var(--blue)", borderRadius: "4px", padding: "0 4px" }}>{mark}</mark></Fragment>; });
  return <>{parts}{text.slice(end)}</>;
}

// Snippet marks from SQLite (\u0001…\u0002) become <mark>; text renders as React text, never HTML.
function marked(text) {
  return String(text || "").split("\u0001").map((part, i) => {
    if (!i) return <Fragment key={i}>{part}</Fragment>;
    const [hit, rest = ""] = part.split("\u0002");
    return <Fragment key={i}><mark style={{ background: "var(--acc2)", color: "inherit", borderRadius: "3px" }}>{hit}</mark>{rest}</Fragment>;
  });
}
const KIND = { text: "", tool_use: "tool call", tool_result: "tool result" };
const promptWhen = (ts) => new Date(ts + IST).toISOString().slice(5, 16).replace("T", " ");
// Full masked message, loaded on demand; long text scrolls in a fixed box.
function PromptText({ id, mark }) {
  const [m, setM] = useState(null);
  const [match, setMatch] = useState(0);
  const box = useRef(null);
  useEffect(() => {
    const el = box.current, target = el?.querySelectorAll("[data-match]")[match];
    if (el && target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 2 + target.clientHeight / 2;
  }, [m, match, mark]);
  useEffect(() => {
    const ctl = new AbortController();
    call(`/api/pii-guard/prompts?id=${id}`, null, ctl.signal).then(setM).catch((e) => { if (!ctl.signal.aborted) setM({ error: e.message }); });
    return () => ctl.abort();
  }, [id]);
  if (!m) return <span style={{ fontSize: "12px", color: "var(--tx3)" }}>Loading…</span>;
  if (m.error) return <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{m.error}</span>;
  const count = occurrences(m.text || "", mark).length;
  return <>{count > 1 && <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "11px" }}><span>{match + 1} of {count}</span><button style={btn} onClick={() => setMatch((match + count - 1) % count)}>Previous</button><button style={btn} onClick={() => setMatch((match + 1) % count)}>Next</button></div>}<pre ref={box} style={{ margin: "0", maxHeight: "360px", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--mono)", fontSize: "12px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--line2)", background: "var(--card)" }}>{mark ? highlight(m.text, mark) : m.text}</pre>
    {m.cut ? <span style={{ fontSize: "11px", color: "var(--tx3)" }}>Cut at the size limit (1 MB, tool output 128 KB).</span> : null}</>;
}
function PromptPeek({ query, mark, openSession }) {
  const [res, setRes] = useState(null);
  useEffect(() => {
    const ctl = new AbortController();
    call(`/api/pii-guard/prompts?${query}&limit=5`, null, ctl.signal).then(setRes).catch(() => { if (!ctl.signal.aborted) setRes({ rows: [] }); });
    return () => ctl.abort();
  }, [query]);
  if (!res) return <span style={{ fontSize: "12px", color: "var(--tx3)" }}>Loading…</span>;
  if (!res.rows?.length) return <span style={{ fontSize: "12px", color: "var(--tx3)" }}>No stored prompt. Prompts are kept 14 days, starting Nov 7, 2026.</span>;
  return <>{res.rows.map((r) => <Fragment key={r.id}><span style={{ fontSize: "11px", color: "var(--tx3)" }}>{r.role}{KIND[r.kind] ? ` · ${KIND[r.kind]}` : ""} · {promptWhen(r.ts)}</span><PromptText id={r.id} mark={mark} />{openSession && r.sessionId && <button onClick={() => openSession(r.id, r.sessionId)} style={{ ...btn, alignSelf: "flex-start" }}>Show whole conversation</button>}</Fragment>)}
    <span style={{ fontSize: "11px", color: "var(--tx3)" }}>Detected values are masked. Text the rules miss, like names, is stored as is.</span></>;
}
// Prompts view: server search, 300 ms after typing stops; a newer search cancels the older one.
function Prompts({ q, session, at, mark, range, tick, clearSession, setSession }) {
  const [state, setState] = useState({ key: null, rows: [], next: null, busy: true, error: "" });
  const [openState, setOpenState] = useState({ fkey: null, id: null });
  // Page cursors belong to one filter; a new filter starts on the newest page.
  const fkey = buildPromptFilterKey(q, session, range);
  const [pageState, setPageState] = useState({ fkey: null, list: [] });
  const pages = useMemo(() => pageState.fkey === fkey ? pageState.list : [], [pageState, fkey]);
  const setPages = (f) => setPageState({ fkey, list: f(pages) });
  const cursor = pages.at(-1) ?? null, pollTick = cursor ? null : tick;
  const requestKey = buildPromptRequestKey(fkey, cursor);
  const currentState = useMemo(() => state.key === requestKey ? state : { key: requestKey, rows: [], next: null, busy: true, error: "" }, [state, requestKey]);
  const open = openState.fkey === fkey ? openState.id : null;
  const setOpen = (id) => setOpenState({ fkey, id });
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      const { from, to } = bounds(range);
      setState((old) => old.key === requestKey ? { ...old, busy: true, error: "" } : old);
      call(`/api/pii-guard/prompts?q=${encodeURIComponent(q)}&sessionId=${encodeURIComponent(session)}&from=${Math.round(from)}&to=${Math.round(to)}${cursor ? `&before=${cursor}` : ""}`, null, ctl.signal)
        .then((r) => { if (!ctl.signal.aborted) setState({ key: requestKey, rows: r.rows || [], next: r.next, busy: false, error: r.unavailable ? "Prompt store unavailable on this server." : "" }); })
        .catch((e) => { if (!ctl.signal.aborted) setState({ key: requestKey, rows: [], next: null, busy: false, error: e.message }); });
    }, 300);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, session, range, cursor, pollTick, requestKey]);
  const target = useRef(null), jumped = useRef("");
  useEffect(() => { jumped.current = ""; }, [at, fkey]);
  useEffect(() => {
    if (!at || !canLandOnPrompt(requestKey, state.key, currentState.busy) || jumped.current === at) return;
    const timer = setTimeout(() => {
      if (currentState.rows.some((r) => String(r.id) === at)) {
        jumped.current = at; setOpenState({ fkey, id: currentState.rows.find((r) => String(r.id) === at).id });
      } else if (currentState.next && pages.length < 9) {
        setState((s) => s.key === requestKey ? { ...s, busy: true } : s);
        setPageState({ fkey, list: [...pages, currentState.next] });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [at, currentState, state.key, requestKey, pages, fkey]);
  useEffect(() => { if (at && String(open) === at) target.current?.scrollIntoView({ block: "center" }); }, [at, open]);
  return <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
    {session && <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--tx2)", padding: "4px 0" }}>Conversation <span style={{ fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" }}>{session}</span><button onClick={clearSession} style={btn}>Show all</button></div>}
    {currentState.error && <div style={{ padding: "16px 0", color: "var(--tx3)", textAlign: "center" }}>{currentState.error}</div>}
    {currentState.rows.map((r) => <div key={r.id} ref={String(r.id) === at ? target : null} style={{ borderTop: "1px solid var(--line)", padding: "8px 0", display: "flex", flexDirection: "column", gap: "4px" }}>
      <button className="r9-pii-prompt-btn" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} style={{ border: "0", background: "transparent", padding: "0", font: "inherit", color: "var(--tx)", textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: "2px", whiteSpace: "normal" }}>
        <span style={{ fontSize: "11px", color: "var(--tx3)" }}>{promptWhen(r.ts)} · {r.role}{KIND[r.kind] ? ` · ${KIND[r.kind]}` : ""} · {r.client || "—"} · <span style={{ fontFamily: "var(--mono)" }}>{r.model || "—"}</span>{r.hashes ? " · has findings" : ""}</span>
        {open !== r.id && <span style={{ fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "3.6em", overflow: "hidden" }}>{marked(r.snip)}</span>}
      </button>
      {open === r.id && <><PromptText id={r.id} mark={String(r.id) === at ? mark : ""} /><span style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "11px", color: "var(--tx3)" }}>Request <span style={{ fontFamily: "var(--mono)" }}>{r.requestId}</span>{r.sessionId && !session && <button onClick={() => setSession(r.sessionId)} style={btn}>Show whole conversation</button>}</span></>}
    </div>)}
    {!currentState.busy && !currentState.error && !currentState.rows.length && <div style={{ padding: "32px 0", textAlign: "center", color: "var(--tx3)" }}>{q ? "No stored prompt has these words." : "No prompts stored in this range yet."}</div>}
    <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
      {pages.length > 0 && <button onClick={() => setPages((p) => p.slice(0, -1))} style={btn}>Newer 50</button>}
      {currentState.next && <button onClick={() => setPages((p) => [...p, currentState.next])} style={btn}>Older 50</button>}
    </div>
    <span style={{ fontSize: "11px", color: "var(--tx3)", paddingTop: "4px" }}>Searches whole words and word starts. Detected values are masked; text the rules miss, like names, is stored as is.</span>
  </div>;
}

function Drawer({ d }) {
  // Broken image = expired; keyed by URL so a new image starts unbroken.
  const [brokenSrc, setBrokenSrc] = useState(null);
  const broken = brokenSrc === d.image;
  useEffect(() => {
    const key = (e) => { if (e.key === "Escape") d.close(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [d]);
  const row = (label, value, mono) => value ? <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}><span style={{ fontSize: "11px", color: "var(--tx3)" }}>{label}</span><span style={{ fontSize: "12.5px", fontFamily: mono ? "var(--mono)" : "inherit", overflowWrap: "anywhere" }}>{value}</span></div> : null;
  if (d.missingHit) return <>
    <div onClick={d.close} style={{ position: "fixed", inset: "0", background: "rgba(0,0,0,.25)", zIndex: 80 }} />
    <aside role="dialog" aria-modal="true" aria-label="Hit details" style={{ position: "fixed", top: "0", right: "0", bottom: "0", width: "min(420px,100vw)", zIndex: 81, background: "var(--card)", borderLeft: "1px solid var(--line2)", boxShadow: "-12px 0 32px rgba(0,0,0,.12)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", borderBottom: "1px solid var(--line)" }}><strong>Hit details</strong><button onClick={d.close} aria-label="Close" style={{ ...btn, padding: "0", width: "28px", justifyContent: "center", fontFamily: "'Material Symbols Outlined'", fontSize: "18px" }}>close</button></div>
      <div style={{ padding: "20px 16px", color: "var(--tx2)", fontSize: "13px" }}>{d.hitStatus === "missing" ? "This hit was not found in the selected range." : d.hitStatus === "error" ? "Could not look up this hit." : "Loading hit details…"}</div>
    </aside>
  </>;
  return (
    <>
      <div onClick={d.close} style={{ position: "fixed", inset: "0", background: "rgba(0,0,0,.25)", zIndex: 80 }} />
      <aside role="dialog" aria-modal="true" aria-label={`${d.title} details`} style={{ position: "fixed", top: "0", right: "0", bottom: "0", width: "min(420px,100vw)", zIndex: 81, background: "var(--card)", borderLeft: "1px solid var(--line2)", boxShadow: "-12px 0 32px rgba(0,0,0,.12)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", padding: "16px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "0" }}><span style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "600", overflowWrap: "anywhere" }}>{d.preview}</span><span style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", color: "var(--tx3)" }}><span style={{ ...badgeSt("var(--card)", "var(--tx2)"), border: "1px solid var(--line2)" }}>{d.rule}</span>{d.group}</span></div>
          <button onClick={d.close} aria-label="Close" style={{ ...btn, padding: "0", width: "28px", justifyContent: "center", fontFamily: "'Material Symbols Outlined'", fontSize: "18px" }}>close</button>
        </div>
        <div style={{ flex: "1", overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <Sec label="Became"><span style={{ fontFamily: d.action === "Redacted" ? "var(--mono)" : "inherit", fontSize: "12.5px" }}>{d.became}</span></Sec>
          <Sec label="Action"><span style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}><span style={badgeSt(d.abg, d.ac)}>{d.action}</span><span style={{ fontSize: "12px", color: "var(--tx2)" }}>{d.why}</span></span></Sec>
          <Sec label="Where in the request"><span style={{ fontSize: "12.5px" }}>{d.where}</span>
            {d.noContext ? <span style={{ fontSize: "12px", color: "var(--tx3)" }}>{d.image ? "Found in an image; see below." : "No context stored. Findings logged before Nov 7 have none."}</span>
              : <><span style={{ fontFamily: "var(--mono)", fontSize: "12px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--line2)", overflowWrap: "anywhere" }}>{highlight(d.context, d.preview)}</span><span style={{ fontSize: "11px", color: "var(--tx3)" }}>About 20 characters on each side, masked. The full prompt is below.</span></>}</Sec>
          {(d.image) && (<Sec label={`Image · ${d.imageLabel}`}>
            {broken ? <span style={{ fontSize: "12px", color: "var(--tx3)", padding: "16px", borderRadius: "6px", background: "var(--seg)", textAlign: "center" }}>Image expired (kept 14 days)</span>
              : <a href={d.image} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- auth-checked API image */}
                <img src={d.image} alt={d.imageLabel} onError={() => setBrokenSrc(d.image)} style={{ width: "100%", maxHeight: "320px", objectFit: "contain", borderRadius: "6px", background: "var(--seg)" }} /></a>}</Sec>)}
          <Sec label="Prompt"><PromptPeek query={d.promptQuery} mark={d.preview} openSession={d.openSession} /></Sec>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {row("Client", d.client)}{row("Model", d.model, true)}{row("Requests", d.reqs)}{row("First seen", d.first)}{row("Last seen", d.last)}{row("Hash", `#${d.hash}`, true)}{row("Request", d.request, true)}{row("Session", d.session, true)}
          </div>
          {(d.pending) && <Confirm p={d.pending} />}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "16px", borderTop: "1px solid var(--line)" }}>
          <button onClick={d.allow} disabled={d.allowPending} aria-busy={d.allowPending || undefined} style={btnSt(btn, d.allowPending)}>{d.allowPending ? <><Spinner />Saving…</> : d.allowLabel}</button>
          <span style={{ marginLeft: "auto", fontSize: "11.5px", color: "var(--tx3)" }}>All {d.rule}:</span>
          <div style={segWrap}>{d.ruleBtns.map((b) => <button key={b.label} onClick={b.on} disabled={b.disabled} aria-busy={b.pending || undefined} style={b.style}>{b.pending && <Spinner />}{b.label}</button>)}</div>
          {d.rulePending && <span role="status" style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Saving…</span>}
        </div>
      </aside>
    </>
  );
}
