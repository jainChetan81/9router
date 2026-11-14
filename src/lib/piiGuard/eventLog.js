// Reads events.jsonl without keeping it: one chunk is in memory at a time, and the caller folds the lines
// into whatever small state it needs. Lines are in time order (appended as they happen), so the start of a
// range is found by bisecting the file instead of reading back to it.
import { open } from "node:fs/promises";

// Small enough that parsing one chunk holds the thread for about 10 ms; reads between chunks yield.
export const CHUNK = 256 * 1024;
// One call reads at most this far back; older than that reports `truncated`.
export const SCAN_CAP = 256 * 1024 * 1024;
const PROBE = 64 * 1024, MAX_LINE = 16 * 1024 * 1024;
// Appends are asynchronous, so two lines may be a moment out of order: start a little early.
const ORDER_SLACK_MS = 60_000;

async function readRange(handle, start, end) {
  const buffer = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await handle.read(buffer, 0, end - start, start);
  return buffer.subarray(0, bytesRead);
}
function parse(line) {
  if (!line) return null;
  try { const e = JSON.parse(line); return e && typeof e === "object" ? e : null; } catch { return null; }
}
export function routingFields(e) {
  const fields = {};
  for (const key of ["provider", "account", "resolvedModel"]) fields[key] = typeof e[key] === "string" ? e[key] : null;
  if (typeof e.combo === "string") fields.combo = e.combo;
  return fields;
}

// First complete line that starts after `at` and has a timestamp: { start, ts }, or null before `limit`.
async function probe(handle, at, limit) {
  let want = PROBE;
  for (;;) {
    const end = Math.min(limit, at + want);
    const buf = await readRange(handle, at, end);
    let from = buf.indexOf(0x0a) + 1;
    while (from > 0) {
      const nl = buf.indexOf(0x0a, from);
      if (nl < 0) break;
      const ts = Date.parse(parse(buf.toString("utf8", from, nl))?.ts);
      if (Number.isFinite(ts)) return { start: at + from, ts };
      from = nl + 1;
    }
    if (end >= limit || want >= MAX_LINE) return null;
    want *= 4;
  }
}

/** Offset of a line start at or before the first line with `ts >= fromMs`. */
export async function findOffset(handle, size, fromMs) {
  const target = fromMs - ORDER_SLACK_MS;
  let lo = 0, hi = size;
  while (hi - lo > CHUNK) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const line = await probe(handle, mid, hi);
    if (line && line.ts < target) lo = line.start; else hi = mid;
  }
  return lo;
}

/** Where a scan for `fromMs` starts. `truncated`: the range begins further back than one call reads. */
export async function rangeStart(handle, size, fromMs) {
  const start = await findOffset(handle, size, fromMs);
  if (size - start <= SCAN_CAP) return { start, truncated: false };
  const line = await probe(handle, size - SCAN_CAP, size);
  return { start: line ? line.start : size, truncated: true };
}

/** Feeds every complete line in [start, size) to `onEvent(event, ts)`, oldest first, a chunk at a time.
 *  Returns the offset after the last complete line: a half-written tail is left for the next call. */
export async function scanForward(handle, start, size, onEvent) {
  let pos = start, done = start, carry = null;
  while (pos < size) {
    const chunk = await readRange(handle, pos, Math.min(size, pos + CHUNK));
    if (!chunk.length) break;
    pos += chunk.length;
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const cut = buf.lastIndexOf(0x0a) + 1;
    if (cut > 0) {
      const text = buf.toString("utf8", 0, cut);
      let from = 0;
      while (from < text.length) {
        const nl = text.indexOf("\n", from);
        if (nl > from) { const e = parse(text.slice(from, nl)); if (e) onEvent(e, Date.parse(e.ts)); }
        from = nl + 1;
      }
      done += cut;
    }
    carry = cut < buf.length ? buf.subarray(cut) : null;
    // A "line" this long is not an event: skip past it rather than hold it.
    if (carry && carry.length > MAX_LINE) { done += carry.length; carry = null; }
  }
  return done;
}

/** Events with `ts >= fromMs`, newest first, each merged with its last routing record (which follows it in
 *  the file, so it is read first). `visit(event, ts)` returns false to stop; only the chunks needed are read.
 *  Returns { truncated }: the scan cap stopped the read before `fromMs`. */
export async function scanBackward(handle, size, fromMs, visit) {
  const routing = new Map();
  let end = size, want = CHUNK, first = true;
  while (end > 0) {
    if (size - end >= SCAN_CAP) return { truncated: true };
    const start = Math.max(0, end - want);
    const buf = await readRange(handle, start, end);
    // The first line of a chunk may be partial: it belongs to the next (older) chunk.
    const head = start === 0 ? 0 : buf.indexOf(0x0a) + 1;
    if (start > 0 && head === 0) { if (want >= MAX_LINE) { end = start; want = CHUNK; } else want *= 2; continue; }
    // Only the newest chunk can end in a half-written line.
    const tail = first ? buf.lastIndexOf(0x0a) + 1 : buf.length;
    first = false;
    if (tail > head) {
      const lines = buf.toString("utf8", head, tail).split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = parse(lines[i]);
        if (!e) continue;
        if (e.kind === "routing") {
          if (typeof e.requestId === "string" && !routing.has(e.requestId)) routing.set(e.requestId, routingFields(e));
          continue;
        }
        const ts = Date.parse(e.ts);
        if (ts < fromMs) return { truncated: false };
        if (visit({ ...e, ...routing.get(e.requestId) }, ts) === false) return { truncated: false };
      }
    }
    end = start + head;
    want = CHUNK;
  }
  return { truncated: false };
}

export async function withLog(file, fn, fallback) {
  let handle;
  try {
    handle = await open(file, "r");
    return await fn(handle, await handle.stat());
  } catch { return fallback; }
  finally { await handle?.close().catch(() => {}); }
}
