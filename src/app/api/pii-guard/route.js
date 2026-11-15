import { NextResponse } from "next/server";
import { clientOf } from "@/lib/spendClient.js";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSettings, updateSettings } from "@/lib/localDb";
import { ready, rules, groups, testText, testImage, eventsFile, health } from "@/lib/piiGuard/observe.js";
import { summarize, createSummarizer, applyIgnoreToSummary } from "@/lib/piiGuard/summary.js";
import { endOffset, rangeStart, scanBackward, scanForward, withLog } from "@/lib/piiGuard/eventLog.js";
import { bump, version } from "@/lib/live/bus.js";
import { isSyncRequest } from "@/lib/dashboardSync.js";

export const dynamic = "force-dynamic";
const MODES = ["off", "observe", "redact", "block"];
const WHERES = ["user", "system", "assistant", "tool_result", "thinking"];
const HASH = /^[0-9a-f]{12}$/;
const MAX_IGNORE = 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const OCR_MODES = ["off", "observe"];
const OCR_QUALITIES = ["basic", "enhanced"];
// The Next server runs from the app dir (dev: repo root; release: standalone dir), which holds public/.
const SAMPLE_DIR = join(process.cwd(), "public/pii-guard-samples");

function normalizeOcr(ocr = {}, current = {}) {
  const envQuality = process.env.PII_GUARD_OCR_MODE === "basic" ? "basic" : "enhanced";
  return {
    mode: OCR_MODES.includes(ocr.mode) ? ocr.mode : OCR_MODES.includes(current.mode) ? current.mode : "observe",
    quality: OCR_QUALITIES.includes(ocr.quality) ? ocr.quality : OCR_QUALITIES.includes(current.quality) ? current.quality : envQuality,
  };
}
function validStoredPiiGuard(settings) {
  const p = settings?.piiGuard;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (!MODES.includes(p.mode)) return null;
  if (p.rules !== undefined && (!p.rules || typeof p.rules !== "object" || Array.isArray(p.rules))) return null;
  if (p.ignore !== undefined && !Array.isArray(p.ignore)) return null;
  if (p.dismissed !== undefined && (!p.dismissed || typeof p.dismissed !== "object" || Array.isArray(p.dismissed))) return null;
  return p;
}
function formatSettingsDiff(prev, next) {
  const parts = [prev.mode !== next.mode ? `mode=${prev.mode}->${next.mode}` : `mode=${next.mode}`];
  const prevOcrMode = OCR_MODES.includes(prev.ocr?.mode) ? prev.ocr.mode : "unset";
  const prevOcrQual = OCR_QUALITIES.includes(prev.ocr?.quality) ? prev.ocr.quality : "unset";
  if (prevOcrMode !== next.ocr.mode) parts.push(`ocr.mode=${prevOcrMode}->${next.ocr.mode}`);
  if (prevOcrQual !== next.ocr.quality) parts.push(`ocr.quality=${prevOcrQual}->${next.ocr.quality}`);
  const prevRules = prev.rules || {}, nextRules = next.rules || {};
  const ruleDiffs = [];
  for (const id of [...new Set([...Object.keys(prevRules), ...Object.keys(nextRules)])].sort()) {
    const before = prevRules[id] || "default", after = nextRules[id] || "default";
    if (before !== after) ruleDiffs.push(`${id}:${before}->${after}`);
  }
  if (ruleDiffs.length) parts.push(`rules=[${ruleDiffs.join(",")}]`);
  parts.push(`overrides=${Object.keys(prevRules).length}->${Object.keys(nextRules).length}`);
  const prevIgnore = Array.isArray(prev.ignore) ? prev.ignore : [];
  const prevSet = new Set(prevIgnore), nextSet = new Set(next.ignore);
  const added = next.ignore.filter((h) => !prevSet.has(h)).length;
  const removed = prevIgnore.filter((h) => !nextSet.has(h)).length;
  if (added || removed) parts.push(`ignore=${prevIgnore.length}->${next.ignore.length}(+${added}/-${removed})`);
  const prevDismissed = prev.dismissed || {}, nextDismissed = next.dismissed || {};
  const prevD = Object.keys(prevDismissed).length, nextD = Object.keys(nextDismissed).length;
  if (prevD !== nextD || JSON.stringify(prevDismissed) !== JSON.stringify(nextDismissed)) {
    parts.push(`dismissed=${prevD}->${nextD}`);
  }
  return parts.join(", ");
}
async function sampleList() {
  try { return JSON.parse(await readFile(join(SAMPLE_DIR, "samples.json"), "utf8")); } catch { return []; }
}
function decodeImage(data) {
  if (typeof data !== "string" || !data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  const buffer = Buffer.from(data, "base64");
  return buffer.length && buffer.length <= MAX_IMAGE_BYTES && buffer.toString("base64") === data ? buffer : null;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 90;
const MAX_SUMMARY_CACHE = 8;
const MAX_LIVE = 3;
const LIVE_IDLE_MS = 10 * 60_000;
// ETags are only comparable within one process: the pii version restarts with it.
const BOOT = randomBytes(4).toString("hex");
// A routing record follows its event in the log, by seconds at most. A range that ended longer ago than
// this is closed: no later append can change it, so nothing about it depends on the end of the file.
const CLOSED_AFTER_MS = 5 * 60_000;
const isClosed = (to, now = Date.now()) => to + CLOSED_AFTER_MS < now;
// Moves on every settings save here; the tag of a closed range uses it in place of the pii version.
let settingsRev = 0;

// The log is never held in memory. A summary of a past range is cached by its exact range and the file's
// state. A range that ends now or later keeps its folded summary and the offset it has read to, so a poll
// folds in only the bytes appended since; that state is dropped after ten idle minutes.
const summaryCache = new Map();
const live = new Map();
let liveTimer = null;
function touchLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => live.clear(), LIVE_IDLE_MS);
  liveTimer.unref?.();
}

let queue = Promise.resolve();
let settingsQueue = Promise.resolve();
function withSettingsLock(fn) {
  const run = settingsQueue.then(fn);
  settingsQueue = run.catch(() => {});
  return run;
}

// Returns { events (newest first, ts >= fromMs), truncated }. truncated: the scan cap stopped the read before `fromMs`.
// `visit(e, ts)`, if given, sees events newest first and returns false to stop; no copy of the range is made
// and only the chunks it needed are read. `untilMs`: nothing later is wanted, so the read starts at that
// point of the file (found by bisection) instead of at its end, and the scan cap counts from there.
export async function loadEvents(fromMs, visit, untilMs = Infinity) {
  const events = [];
  const { truncated } = await withLog(eventsFile(), async (handle, st) => {
    const end = Number.isFinite(untilMs) && isClosed(untilMs) ? await endOffset(handle, st.size, untilMs + CLOSED_AFTER_MS) : st.size;
    return scanBackward(handle, end, fromMs, visit || ((e) => { events.push(e); }));
  }, { truncated: false });
  return { events, truncated };
}

function recordRecentHits(rawEvent, ts, sinceMs, untilMs, firstSeen) {
  if (!rawEvent || rawEvent.kind === "routing") return;
  if (rawEvent.type === "test" || rawEvent.test === true) return;
  if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) return;
  if (rawEvent.type === "error" || rawEvent.type === "stats") return;
  const raw = Array.isArray(rawEvent.hits) ? rawEvent.hits : Array.isArray(rawEvent.new) ? rawEvent.new : [];
  for (const hit of raw) {
    if (!hit || typeof hit.hash !== "string" || typeof hit.rule !== "string") continue;
    const key = `${hit.hash}\0${hit.rule}`;
    const prev = firstSeen.get(key);
    if (prev === undefined || ts < prev) firstSeen.set(key, ts);
  }
}

// Values first seen in the last `minutes`, judged against the last 24 hours of the log.
function findRecentNewHashes(minutes) {
  const now = Date.now();
  const cutoff = now - minutes * 60_000;
  const since = now - DAY;
  return withLog(eventsFile(), async (handle, st) => {
    const { start, truncated } = await rangeStart(handle, st.size, since);
    if (truncated) return { hashes: [], truncated: true };
    const firstSeen = new Map();
    await scanForward(handle, start, st.size, (e, ts) => recordRecentHits(e, ts, since, now, firstSeen));
    const hashes = [];
    for (const [key, firstMs] of firstSeen) if (firstMs >= cutoff) hashes.push(key.slice(0, key.indexOf("\0")));
    return { hashes, truncated: false };
  }, { hashes: [], truncated: false });
}

// A closed range is keyed on its bounds and the file's identity only: appends do not change it.
function baseSummaryKey(file, from, to, step, origin, st) {
  const id = `${file}|${Math.floor(from / 6e4)}|${Math.floor(to / 6e4)}|${step}|${origin}|${st?.ino ?? ""}|${st?.birthtimeMs ?? ""}`;
  return isClosed(to) ? `${id}|closed` : `${id}|${st?.size ?? 0}|${st?.mtimeMs ?? 0}`;
}
function getCachedBaseSummary(key) {
  const hit = summaryCache.get(key);
  if (!hit) return null;
  summaryCache.delete(key);
  summaryCache.set(key, hit);
  return hit;
}
function setCachedBaseSummary(key, value) {
  summaryCache.delete(key);
  summaryCache.set(key, value);
  if (summaryCache.size > MAX_SUMMARY_CACHE) {
    summaryCache.delete(summaryCache.keys().next().value);
  }
}
const fold = (summarizer) => (e, ts) => (e.kind === "routing" ? summarizer.route(e) : summarizer.add(e, ts));
// A range ending now or later: every event in the file is inside it, so its summary only ever grows.
async function liveSummary(handle, st, file, from, to, step, origin) {
  const key = `${file}|${from}|${step}|${origin}`;
  let entry = live.get(key);
  if (!entry || entry.ino !== st.ino || entry.born !== st.birthtimeMs || st.size < entry.end) {
    const { start, truncated } = await rangeStart(handle, st.size, from);
    entry = { ino: st.ino, born: st.birthtimeMs, end: start, truncated, summarizer: createSummarizer({ since: from, step, origin, open: true }) };
  }
  live.delete(key);
  if (st.size > entry.end) {
    // A failed read leaves the entry out of the map: a half-folded chunk must not be counted twice.
    entry.end = await scanForward(handle, entry.end, st.size, fold(entry.summarizer));
  }
  live.set(key, entry);
  while (live.size > MAX_LIVE) live.delete(live.keys().next().value);
  touchLive();
  return { ...entry.summarizer.finish({ until: to }), truncated: entry.truncated, step, origin };
}
async function rangeSummary(handle, st, from, to, step, origin) {
  // A little past `to`, not to the end of the file: a routing record follows its event, possibly after `to`.
  const end = isClosed(to) ? await endOffset(handle, st.size, to + CLOSED_AFTER_MS) : st.size;
  const { start, truncated } = await rangeStart(handle, end, from);
  const summarizer = createSummarizer({ since: from, until: to, step, origin });
  await scanForward(handle, start, end, fold(summarizer));
  return { ...summarizer.finish(), truncated, step, origin };
}
// Calls run one at a time: polls and two tabs share the live state.
function loadBaseSummary(file, from, to, step, origin, fresh = false) {
  const run = queue.then(() => withLog(file, async (handle, st) => {
    const key = baseSummaryKey(file, from, to, step, origin, st);
    const cached = fresh ? null : getCachedBaseSummary(key);
    if (cached) return cached;
    const summary = to >= Date.now() ? await liveSummary(handle, st, file, from, to, step, origin) : await rangeSummary(handle, st, from, to, step, origin);
    setCachedBaseSummary(key, summary);
    return summary;
  }, null)).then((summary) => summary || { ...summarize([], { since: from, until: to, ignore: [], step, origin }), truncated: false, step, origin });
  queue = run.catch(() => {});
  return run;
}

function validateRange(from, to) {
  if (from === undefined && to === undefined) return null;
  const f = from === undefined ? undefined : Number(from);
  const t = to === undefined ? undefined : Number(to);
  if (from !== undefined && (!Number.isInteger(f) || String(from).trim() === "")) return "bad";
  if (to !== undefined && (!Number.isInteger(t) || String(to).trim() === "")) return "bad";
  const now = Date.now();
  const fMs = from === undefined ? now - DAY : f;
  const tMs = to === undefined ? now : t;
  if (!(fMs < tMs)) return "bad";
  if (tMs - fMs > MAX_DAYS * DAY) return "bad";
  return { from: fMs, to: tMs };
}

// `fresh` (a sync request): the summary is read from the log now, not taken from the summary cache.
async function state(fromMs, toMs, fresh = false) {
  const file = eventsFile();
  const [settings, available, st] = await Promise.all([getSettings(), ready(), stat(file).catch(() => null)]);
  const rawPii = validStoredPiiGuard(settings);
  if (!rawPii) throw new Error("PII Guard settings unavailable or invalid");
  const now = Date.now();
  const from = Number.isFinite(fromMs) ? fromMs : now - DAY;
  const to = Number.isFinite(toMs) ? toMs : now;
  const config = { ...rawPii, ocr: normalizeOcr(rawPii.ocr), ignore: Array.isArray(rawPii.ignore) ? rawPii.ignore : [] };
  // Hourly buckets up to two days, else IST days.
  const IST = 5.5 * 3600e3, step = to - from <= 2 * DAY ? 3600e3 : DAY;
  const origin = step === DAY ? Math.floor((from + IST) / DAY) * DAY - IST : Math.floor(from / 3600e3) * 3600e3;
  // Separate parsed-event/base summary caching from config.ignore so config changes re-project in memory.
  const key = baseSummaryKey(file, from, to, step, origin, st);
  let baseSummary = fresh ? null : getCachedBaseSummary(key);
  if (!baseSummary) {
    baseSummary = await loadBaseSummary(file, from, to, step, origin, fresh);
  }
  const summary = applyIgnoreToSummary(baseSummary, config.ignore);
  return { enabled: !!process.env.PII_GUARD_MODULE, available, config, rules: available ? rules() : [], groups: available ? groups() : [], health: health(config), summary };
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("samples") === "1") return NextResponse.json(await sampleList());
  // Events pager: newest first, stats skipped. Cursor `before` (ms) + `skip` (events at exactly that ms already sent),
  // so events sharing a timestamp across a page boundary are not lost.
  if (url.searchParams.get("events") === "1") {
    const num = (k, d) => { const v = url.searchParams.get(k); return v === null ? d : Number(v); };
    const before = num("before", Infinity), skip = num("skip", 0);
    if ((before !== Infinity && !Number.isInteger(before)) || !Number.isInteger(skip) || skip < 0) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    let limit = num("limit", 50);
    if (!Number.isInteger(limit) || limit < 1) limit = 50;
    limit = Math.min(limit, 200);
    const vr = validateRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
    if (vr === "bad") return NextResponse.json({ error: "Invalid range" }, { status: 400 });
    const range = vr || { from: Date.now() - DAY, to: Date.now() };
    // Filters, same meaning in both Findings views. action "allowed" means the hash is on the allow (ignore) list now.
    const f = Object.fromEntries(["model", "client", "source", "action", "group", "provider", "combo", "q"].map((k) => [k, (url.searchParams.get(k) || "").slice(0, 200)]));
    const tests = url.searchParams.get("tests") === "1";
    const q = f.q.toLowerCase();
    const allowed = new Set(f.action === "allowed" || q ? ((await getSettings()).piiGuard?.ignore || []) : []);
    const ruleList = f.group || q ? rules() : [];
    const groupOf = Object.fromEntries(ruleList.map((r) => [r.id, r.group]));
    const labelOf = Object.fromEntries(ruleList.map((r) => [r.id, r.label || r.id]));
    const keep = (e) => (tests || !(e.type === "test" || e.test === true)) && (!f.model || e.model === f.model) && (!f.client || clientOf(e.ua || "") === f.client)
      && (!f.provider || e.provider === f.provider) && (!f.combo || e.combo === f.combo);
    // Allowed = allowed now, or allowed when it was logged; the row badge uses the logged action.
    const actionOk = (h) => f.action === "allowed" ? h.action === "ignored" || allowed.has(h.hash) : (h.action || "observe") === f.action;
    const text = (e, h) => [h.rule, h.name, labelOf[h.rule], h.hash, h.preview, h.source, e.model, e.provider, e.combo, clientOf(e.ua || "")].join(" ").toLowerCase();
    const hitOk = (e, h) => (!f.action || actionOk(h)) && (!f.source || (f.source === "ocr") === String(h.source || "").endsWith("/ocr"))
      && (!f.group || groupOf[h.rule] === f.group) && (!q || text(e, h).includes(q));
    const filtered = f.action || f.source || f.group || q;
    const page = [];
    // `seen`: events visited at timestamp `seenTs`, kept or filtered out, so the cursor skips exactly those.
    let skipped = 0, seenTs = NaN, seen = 0, lastSeen = 0;
    const { truncated } = await loadEvents(range.from, (e, ts) => {
      if (!(ts <= range.to) || ts > before) return;
      if (ts === before && skipped < skip) { skipped++; return; }
      if (ts !== seenTs) { seenTs = ts; seen = 0; }
      seen++;
      if (e.type === "stats" || !keep(e)) return;
      const hits = filtered ? (e.hits || []).filter((h) => hitOk(e, h)) : e.hits;
      if (!hits?.length) return;
      page.push({ ...e, hits, client: clientOf(e.ua || "") });
      lastSeen = seen;
      return page.length < limit;
    }, Math.min(range.to, before));
    const last = page.at(-1);
    let next = null;
    if (page.length === limit) {
      const ts = Date.parse(last.ts);
      next = { before: ts, skip: lastSeen + (ts === before ? skip : 0) };
    }
    // `truncated`: the scan cap stopped this page before the range start, so "no next page" is not the end.
    return NextResponse.json({ events: page, next, truncated: !next && truncated });
  }

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if (fromRaw !== null || toRaw !== null) {
    const vr = validateRange(fromRaw, toRaw);
    if (vr === "bad") return NextResponse.json({ error: "Invalid range" }, { status: 400 });
    // The pii topic version moves on every log append and settings save. An unchanged version for the same
    // range answers 304 before the log or the settings are read. The minute keeps the health counters
    // (which move without a log append) at most a minute old. A closed range does not change with the
    // log, so its tag moves with settings saves only.
    const rev = isClosed(vr.to) ? `c${settingsRev}` : version("pii");
    const etag = `W/"pii-${BOOT}-${rev}-${vr.from}-${vr.to}-${Math.floor(Date.now() / 6e4)}"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
    // "Sync now" asked for a fresh body: no 304 and no cached summary.
    const sync = isSyncRequest(request);
    if (!sync && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const s = await state(vr.from, vr.to, sync);
    return NextResponse.json(s, { headers });
  }
  // default last 24h
  const s = await state();
  return NextResponse.json(s);
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  if (body.testImage !== undefined) {
    let settings;
    try { settings = await getSettings(); } catch { return NextResponse.json({ error: "PII Guard settings unavailable" }, { status: 500 }); }
    const current = validStoredPiiGuard(settings);
    if (!current) return NextResponse.json({ error: "Invalid PII Guard settings" }, { status: 500 });
    if (!body.testImage || typeof body.testImage !== "object" || Array.isArray(body.testImage)) return NextResponse.json({ error: "Invalid image test" }, { status: 400 });
    const samples = await sampleList();
    let buffer, sample;
    if (typeof body.testImage.sample === "string") {
      sample = samples.find(item => item?.id === body.testImage.sample);
      if (!sample || typeof sample.file !== "string" || !/^[a-z0-9_-]+\.png$/i.test(sample.file)) return NextResponse.json({ error: "Invalid sample" }, { status: 400 });
      try { buffer = await readFile(join(SAMPLE_DIR, sample.file)); } catch { return NextResponse.json({ error: "Invalid sample" }, { status: 400 }); }
      if (buffer.length > MAX_IMAGE_BYTES) return NextResponse.json({ error: "Image too large" }, { status: 400 });
    } else {
      buffer = decodeImage(body.testImage.data);
      if (!buffer) return NextResponse.json({ error: "Invalid image data" }, { status: 400 });
    }
    if (body.testQuality !== undefined && ![...OCR_QUALITIES, "compare"].includes(body.testQuality)) return NextResponse.json({ error: "Invalid test quality" }, { status: 400 });
    if (body.testMode !== undefined && !["current", ...MODES].includes(body.testMode)) return NextResponse.json({ error: "Invalid test mode" }, { status: 400 });
    // Same as the text test: a mode preview applies to all rules.
    const config = body.testMode && body.testMode !== "current" ? { mode: body.testMode, rules: {} } : current;
    const qualities = body.testQuality === "compare" ? ["basic", "enhanced"] : [body.testQuality || normalizeOcr(current.ocr).quality];
    try {
      const results = [];
      for (const quality of qualities) {
        const result = await testImage(buffer, config, quality, { sample: sample?.id });
        if (!result) return NextResponse.json({ error: "Image OCR unavailable" }, { status: 503 });
        results.push({ mode: result.mode, status: result.status, text: result.text, chars: result.chars, meanConfidence: result.meanConfidence, ocrMs: result.ocrMs, findings: result.findings });
      }
      return NextResponse.json({ results, ...(sample && { expect: sample.expect }), note: "Images are observed only; a real request is not changed." });
    } catch { return NextResponse.json({ error: "Image OCR unavailable" }, { status: 503 }); }
  }
  if (typeof body.test === "string") {
    if (body.test.length > 100_000) return NextResponse.json({ error: "Text too long" }, { status: 400 });
    let settings;
    try { settings = await getSettings(); } catch { return NextResponse.json({ error: "PII Guard settings unavailable" }, { status: 500 }); }
    const current = validStoredPiiGuard(settings);
    if (!current) return NextResponse.json({ error: "Invalid PII Guard settings" }, { status: 500 });
    const config = MODES.includes(body.testMode) ? { mode: body.testMode, rules: {} } : current;
    const result = await testText(body.test, config, WHERES.includes(body.testWhere) ? body.testWhere : "user");
    return result ? NextResponse.json(result) : NextResponse.json({ error: "Scanner unavailable" }, { status: 503 });
  }

  // Validate request payload before any file scan or lock acquisition.
  if (body.dismiss !== undefined) {
    const entries = body.dismiss && typeof body.dismiss === "object" && !Array.isArray(body.dismiss) ? Object.entries(body.dismiss) : null;
    if (!entries || entries.length > MAX_IGNORE || entries.some(([h, w]) => !HASH.test(h) || !Array.isArray(w) || w.length > 20 || w.some(x => typeof x !== "string" || x.length > 40))) return NextResponse.json({ error: "Invalid dismiss" }, { status: 400 });
  }
  if (body.undismiss !== undefined) {
    if (!Array.isArray(body.undismiss) || body.undismiss.length > MAX_IGNORE || body.undismiss.some(h => typeof h !== "string" || !HASH.test(h))) return NextResponse.json({ error: "Invalid dismiss" }, { status: 400 });
  }
  if (body.ocr !== undefined) {
    if (!body.ocr || typeof body.ocr !== "object" || Array.isArray(body.ocr) || Object.keys(body.ocr).some(key => !["mode", "quality"].includes(key)) || (body.ocr.mode !== undefined && !OCR_MODES.includes(body.ocr.mode)) || (body.ocr.quality !== undefined && !OCR_QUALITIES.includes(body.ocr.quality))) return NextResponse.json({ error: "Invalid OCR setting" }, { status: 400 });
  }
  if (body.ignore !== undefined) {
    if (typeof body.ignore !== "string" || !HASH.test(body.ignore) || typeof body.on !== "boolean") return NextResponse.json({ error: "Invalid ignore setting" }, { status: 400 });
  }
  let resolvedHashes = null;
  if (body.ignoreMany !== undefined || body.ignoreRecent !== undefined) {
    if (typeof body.on !== "boolean") return NextResponse.json({ error: "Invalid ignore setting" }, { status: 400 });
    if (body.ignoreMany !== undefined) {
      if (!Array.isArray(body.ignoreMany) || body.ignoreMany.length > MAX_IGNORE || body.ignoreMany.some(h => typeof h !== "string" || !HASH.test(h))) return NextResponse.json({ error: "Invalid ignore setting" }, { status: 400 });
      resolvedHashes = body.ignoreMany;
    } else {
      if (!Number.isInteger(body.ignoreRecent) || body.ignoreRecent < 1 || body.ignoreRecent > 1440) return NextResponse.json({ error: "Invalid ignore setting" }, { status: 400 });
      const { hashes, truncated } = await findRecentNewHashes(body.ignoreRecent);
      if (truncated) return NextResponse.json({ error: "Event log window too short to tell which values are new" }, { status: 409 });
      resolvedHashes = hashes;
    }
  }
  if (body.mode !== undefined && !MODES.includes(body.mode)) return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  if (body.rules !== undefined && (!body.rules || typeof body.rules !== "object" || Array.isArray(body.rules))) return NextResponse.json({ error: "Invalid rules setting" }, { status: 400 });

  // Serialize settings read-modify-write after any async log read so concurrent writes never clobber newer changes.
  return await withSettingsLock(async () => {
    let settings;
    try { settings = await getSettings(); } catch { return NextResponse.json({ error: "PII Guard settings unavailable; write refused" }, { status: 500 }); }
    const current = validStoredPiiGuard(settings);
    if (!current) return NextResponse.json({ error: "PII Guard settings invalid; write refused" }, { status: 500 });

    const next = {
      mode: current.mode,
      rules: { ...(current.rules || {}) },
      ignore: Array.isArray(current.ignore) ? [...current.ignore] : [],
      ocr: normalizeOcr(current.ocr),
      dismissed: { ...(current.dismissed || {}) },
    };
    // Dismissed "couldn't redact" rows: hash -> places seen when dismissed. A new place shows the row again.
    if (body.dismiss !== undefined) {
      for (const [h, w] of Object.entries(body.dismiss)) next.dismissed[h] = w;
      const keys = Object.keys(next.dismissed);
      for (const h of keys.slice(0, Math.max(0, keys.length - MAX_IGNORE))) delete next.dismissed[h];
    }
    if (body.undismiss !== undefined) {
      for (const h of body.undismiss) delete next.dismissed[h];
    }
    if (body.ocr !== undefined) {
      next.ocr = normalizeOcr(body.ocr, current.ocr);
    }
    if (body.ignore !== undefined) {
      next.ignore = body.on ? [...new Set([...next.ignore, body.ignore])].slice(-MAX_IGNORE) : next.ignore.filter(hash => hash !== body.ignore);
    }
    if (resolvedHashes !== null) {
      const drop = new Set(resolvedHashes);
      if (body.on) {
        const merged = [...new Set([...next.ignore, ...resolvedHashes])];
        if (merged.length > MAX_IGNORE) return NextResponse.json({ error: `Ignore list is limited to ${MAX_IGNORE} values` }, { status: 400 });
        next.ignore = merged;
      } else {
        next.ignore = next.ignore.filter(hash => !drop.has(hash));
      }
    }
    if (body.mode !== undefined) {
      next.mode = body.mode;
    }
    if (body.rules !== undefined) {
      for (const [id, mode] of Object.entries(body.rules)) {
        if (!/^[a-z0-9_]{1,40}$/.test(id)) continue;
        if (mode === null || mode === "default") delete next.rules[id];
        else if (MODES.includes(mode)) next.rules[id] = mode;
      }
    }
    await updateSettings({ piiGuard: next });
    settingsRev++;
    bump("pii");
    console.info(`[pii-guard] Settings changed: ${formatSettingsDiff(current, next)}`);
    // The UI updates config/ignore in place from this response; no summary is built here.
    return NextResponse.json({ ok: true, config: next });
  });
}
