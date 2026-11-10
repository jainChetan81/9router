import { NextResponse } from "next/server";
import { clientOf } from "@/lib/spendClient.js";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSettings, updateSettings } from "@/lib/localDb";
import { ready, rules, groups, testText, testImage, eventsFile, health } from "@/lib/piiGuard/observe.js";
import { summarize, applyIgnoreToSummary } from "@/lib/piiGuard/summary.js";

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
const CHUNK = 1024 * 1024;
// ponytail: reads at most 64 MiB back (~12 days at 5 MB/day). Upgrade path: rotate events.jsonl or keep a daily index.
const CAP = 64 * 1024 * 1024;
const MAX_SUMMARY_CACHE = 8;

// Parsed events, oldest first, for one file. `start` is the byte offset of the oldest parsed line,
// `end` the offset after the newest complete line. Polls read only bytes appended after `end`;
// an older `from` reads backward from `start`. A new inode or a shrunk file resets the cache.
let cache = null;
const summaryCache = new Map();

async function readRange(handle, start, end) {
  const buffer = Buffer.alloc(end - start);
  const { bytesRead } = await handle.read(buffer, 0, end - start, start);
  return buffer.subarray(0, bytesRead);
}

function parseLinesWithTimes(buf) {
  const events = [];
  const times = [];
  const routing = new Map();
  let sawNonRouting = false;
  let firstNonRoutingTs = NaN;
  const text = buf.toString("utf8");
  let start = 0;
  while (start < text.length) {
    let nl = text.indexOf("\n", start);
    if (nl === -1) nl = text.length;
    if (nl > start) {
      try {
        const e = JSON.parse(text.slice(start, nl));
        const ts = Date.parse(e?.ts);
        events.push(e);
        times.push(ts);
        if (e?.kind === "routing") {
          if (typeof e.requestId === "string") {
            const fields = {};
            for (const key of ["provider", "account", "resolvedModel"]) fields[key] = typeof e[key] === "string" ? e[key] : null;
            if (typeof e.combo === "string") fields.combo = e.combo;
            routing.set(e.requestId, fields);
          }
        } else if (!sawNonRouting) {
          sawNonRouting = true;
          firstNonRoutingTs = ts;
        }
      } catch {}
    }
    start = nl + 1;
  }
  return { events, times, routing, sawNonRouting, firstNonRoutingTs };
}

function findStartIndex(c, fromMs) {
  for (let i = c.events.length - 1; i >= 0; i--) {
    if (c.events[i].kind === "routing") continue;
    if (c.times[i] < fromMs) return i + 1;
  }
  return 0;
}

async function ensureCachedEvents(handle, file, st, fromMs) {
  const { ino, birthtimeMs, size } = st;
  if (!cache || cache.file !== file || cache.ino !== ino || cache.born !== birthtimeMs || size < cache.end) {
    // Start at the last complete line; a half-written tail is read on the next call.
    const tailFrom = Math.max(0, size - CHUNK);
    const tail = await readRange(handle, tailFrom, size);
    const lastNl = tail.lastIndexOf(0x0a);
    const end = lastNl >= 0 ? tailFrom + lastNl + 1 : tailFrom;
    cache = { file, ino, born: birthtimeMs, start: end, end, events: [], times: [], routing: new Map(), sawNonRouting: false, oldestNonRoutingMs: NaN };
    if (lastNl >= 0) {
      const firstNl = tailFrom === 0 ? -1 : tail.indexOf(0x0a);
      const sliceStart = tailFrom === 0 ? 0 : (firstNl >= 0 && firstNl < lastNl ? firstNl + 1 : -1);
      if (sliceStart >= 0) {
        const parsed = parseLinesWithTimes(tail.subarray(sliceStart, lastNl + 1));
        cache.start = tailFrom + sliceStart;
        cache.events = parsed.events;
        cache.times = parsed.times;
        cache.routing = parsed.routing;
        cache.sawNonRouting = parsed.sawNonRouting;
        cache.oldestNonRoutingMs = parsed.firstNonRoutingTs;
      }
    }
  }
  if (size > cache.end) {
    const buf = await readRange(handle, cache.end, size);
    const cut = buf.lastIndexOf(0x0a) + 1;
    if (cut > 0) {
      const parsed = parseLinesWithTimes(buf.subarray(0, cut));
      for (let i = 0; i < parsed.events.length; i++) {
        cache.events.push(parsed.events[i]); // no spread: a big append would overflow the call stack
        cache.times.push(parsed.times[i]);
      }
      for (const [reqId, fields] of parsed.routing) cache.routing.set(reqId, fields);
      if (!cache.sawNonRouting && parsed.sawNonRouting) {
        cache.sawNonRouting = true;
        cache.oldestNonRoutingMs = parsed.firstNonRoutingTs;
      }
      cache.end += cut;
    }
  }
  let back = CHUNK;
  let curStart = cache.start;
  const prepended = [];
  while (curStart > 0 && cache.end - curStart < CAP && !(cache.oldestNonRoutingMs < fromMs)) {
    const from = Math.max(0, curStart - back);
    const buf = await readRange(handle, from, curStart);
    const cut = from === 0 ? 0 : buf.indexOf(0x0a) + 1; // the first line may be partial; the next round reads it whole
    if (from > 0 && cut === 0) { back *= 2; if (back > CAP) break; continue; }
    const parsed = parseLinesWithTimes(buf.subarray(cut));
    prepended.push(parsed);
    curStart = from + cut;
    if (parsed.sawNonRouting) {
      cache.sawNonRouting = true;
      cache.oldestNonRoutingMs = parsed.firstNonRoutingTs;
    }
    back = CHUNK;
  }
  if (prepended.length > 0) {
    const newEvents = [];
    const newTimes = [];
    for (let c = prepended.length - 1; c >= 0; c--) {
      const { events, times } = prepended[c];
      for (let i = 0; i < events.length; i++) {
        newEvents.push(events[i]);
        newTimes.push(times[i]);
      }
    }
    for (let i = 0; i < cache.events.length; i++) {
      newEvents.push(cache.events[i]);
      newTimes.push(cache.times[i]);
    }
    // Existing cache.routing is newer than prepended[0], which is newer than prepended[1], etc.
    for (let c = 0; c < prepended.length; c++) {
      for (const [reqId, fields] of prepended[c].routing) {
        if (!cache.routing.has(reqId)) cache.routing.set(reqId, fields);
      }
    }
    cache.events = newEvents;
    cache.times = newTimes;
    cache.start = curStart;
  }
  return cache.start > 0 && !(cache.oldestNonRoutingMs <= fromMs);
}

// Returns { events (newest first, ts >= fromMs), truncated }. truncated: the cap stopped the read before `fromMs`.
// Calls run one at a time: polls, the events pager and two tabs share one cache.
let queue = Promise.resolve();
let settingsQueue = Promise.resolve();
function withSettingsLock(fn) {
  const run = settingsQueue.then(fn);
  settingsQueue = run.catch(() => {});
  return run;
}

// `visit(e)`, if given, sees events newest first and returns false to stop; no copy of the range is made.
export function loadEvents(fromMs, visit) {
  const run = queue.then(() => readEvents(fromMs, visit));
  queue = run.catch(() => {});
  return run;
}

async function readEvents(fromMs, visit) {
  const file = eventsFile();
  let handle;
  try {
    handle = await open(file, "r");
    const st = await handle.stat();
    const truncated = await ensureCachedEvents(handle, file, st, fromMs);
    const out = [];
    for (let i = cache.events.length - 1; i >= 0; i--) {
      const raw = cache.events[i];
      if (raw.kind === "routing") continue;
      const ts = cache.times[i];
      if (ts < fromMs) break;
      const event = { ...raw, ...cache.routing.get(raw.requestId) };
      if (visit) { if (visit(event, ts) === false) break; } else out.push(event);
    }
    // Appends grow the cache past CAP over a long uptime; rebuild it on the next call.
    if (cache.end - cache.start > CAP * 1.5) cache = null;
    return { events: out, truncated };
  } catch { return { events: [], truncated: false }; }
  finally { await handle?.close().catch(() => {}); }
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

function extractHashesAfterCutoff(firstSeen, cutoff) {
  const hashes = [];
  for (const [key, firstMs] of firstSeen) {
    if (firstMs >= cutoff) hashes.push(key.slice(0, key.indexOf("\0")));
  }
  return hashes;
}

// Reads only the last 24h window off the long-read queue so slow GET reads never block POST ignoreRecent.
async function findRecentNewHashes(minutes) {
  const now = Date.now();
  const cutoff = now - minutes * 60_000;
  const since = now - DAY;
  const file = eventsFile();
  let handle;
  try {
    const st = await stat(file).catch(() => null);
    if (!st) return { hashes: [], truncated: false };
    if (
      cache &&
      cache.file === file &&
      cache.ino === st.ino &&
      cache.born === st.birthtimeMs &&
      st.size === cache.end &&
      (cache.start === 0 || cache.oldestNonRoutingMs <= since)
    ) {
      const startIdx = findStartIndex(cache, since);
      const firstSeen = new Map();
      for (let i = startIdx; i < cache.events.length; i++) {
        recordRecentHits(cache.events[i], cache.times[i], since, now, firstSeen);
      }
      return { hashes: extractHashesAfterCutoff(firstSeen, cutoff), truncated: false };
    }
    handle = await open(file, "r");
    const fst = await handle.stat();
    const tailFrom = Math.max(0, fst.size - CHUNK);
    const tail = await readRange(handle, tailFrom, fst.size);
    const lastNl = tail.lastIndexOf(0x0a);
    const end = lastNl >= 0 ? tailFrom + lastNl + 1 : tailFrom;
    let start = end;
    const chunks = [];
    let sawNonRouting = false;
    let oldestMs = NaN;
    if (lastNl >= 0) {
      const firstNl = tailFrom === 0 ? -1 : tail.indexOf(0x0a);
      const sliceStart = tailFrom === 0 ? 0 : (firstNl >= 0 && firstNl < lastNl ? firstNl + 1 : -1);
      if (sliceStart >= 0) {
        const parsed = parseLinesWithTimes(tail.subarray(sliceStart, lastNl + 1));
        chunks.push(parsed);
        if (parsed.sawNonRouting) {
          sawNonRouting = true;
          oldestMs = parsed.firstNonRoutingTs;
        }
        start = tailFrom + sliceStart;
      }
    }
    let back = CHUNK;
    while (start > 0 && end - start < CAP && !(oldestMs < since)) {
      const from = Math.max(0, start - back);
      const buf = await readRange(handle, from, start);
      const cut = from === 0 ? 0 : buf.indexOf(0x0a) + 1;
      if (from > 0 && cut === 0) { back *= 2; if (back > CAP) break; continue; }
      const parsed = parseLinesWithTimes(buf.subarray(cut));
      chunks.push(parsed);
      if (parsed.sawNonRouting) {
        sawNonRouting = true;
        oldestMs = parsed.firstNonRoutingTs;
      }
      start = from + cut;
      back = CHUNK;
    }
    const truncated = start > 0 && !(sawNonRouting && oldestMs <= since);
    if (truncated) return { hashes: [], truncated: true };
    const firstSeen = new Map();
    for (let c = chunks.length - 1; c >= 0; c--) {
      const { events, times } = chunks[c];
      for (let i = 0; i < events.length; i++) {
        recordRecentHits(events[i], times[i], since, now, firstSeen);
      }
    }
    return { hashes: extractHashesAfterCutoff(firstSeen, cutoff), truncated: false };
  } catch {
    return { hashes: [], truncated: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function baseSummaryKey(file, from, to, step, origin, st) {
  return `${file}|${Math.floor(from / 6e4)}|${Math.floor(to / 6e4)}|${step}|${origin}|${st?.ino ?? ""}|${st?.birthtimeMs ?? ""}|${st?.size ?? 0}|${st?.mtimeMs ?? 0}`;
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
function loadBaseSummary(file, from, to, step, origin) {
  const run = queue.then(async () => {
    let handle;
    try {
      handle = await open(file, "r");
      const fst = await handle.stat();
      const fKey = baseSummaryKey(file, from, to, step, origin, fst);
      const cached = getCachedBaseSummary(fKey);
      if (cached) return cached;
      const truncated = await ensureCachedEvents(handle, file, fst, from);
      const startIndex = findStartIndex(cache, from);
      const baseSummary = {
        ...summarize(cache.events, { since: from, until: to, ignore: [], step, origin, routing: cache.routing, times: cache.times, startIndex }),
        truncated,
        step,
        origin,
      };
      if (cache.end - cache.start > CAP * 1.5) cache = null;
      setCachedBaseSummary(fKey, baseSummary);
      return baseSummary;
    } catch {
      return { ...summarize([], { since: from, until: to, ignore: [], step, origin }), truncated: false, step, origin };
    } finally {
      await handle?.close().catch(() => {});
    }
  });
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

async function state(fromMs, toMs) {
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
  let baseSummary = getCachedBaseSummary(key);
  if (!baseSummary) {
    baseSummary = await loadBaseSummary(file, from, to, step, origin);
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
    await loadEvents(range.from, (e, ts) => {
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
    });
    const last = page.at(-1);
    let next = null;
    if (page.length === limit) {
      const ts = Date.parse(last.ts);
      next = { before: ts, skip: lastSeen + (ts === before ? skip : 0) };
    }
    return NextResponse.json({ events: page, next });
  }

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if (fromRaw !== null || toRaw !== null) {
    const vr = validateRange(fromRaw, toRaw);
    if (vr === "bad") return NextResponse.json({ error: "Invalid range" }, { status: 400 });
    const s = await state(vr.from, vr.to);
    return NextResponse.json(s);
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
    console.info(`[pii-guard] Settings changed: ${formatSettingsDiff(current, next)}`);
    // The UI updates config/ignore in place from this response; no summary is built here.
    return NextResponse.json({ ok: true, config: next });
  });
}
