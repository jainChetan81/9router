import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const paths = vi.hoisted(() => ({ file: "" }));
const settings = vi.hoisted(() => ({ piiGuard: { mode: "observe", rules: {}, ignore: [] } }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => settings, updateSettings: async (u) => { settings.piiGuard = u.piiGuard; } }));
vi.mock("@/lib/piiGuard/observe.js", () => ({ ready: async () => true, rules: () => [], groups: () => [], testText: async () => null, testImage: async () => null, eventsFile: () => paths.file, health: () => ({}) }));

import { GET, POST, loadEvents } from "../../src/app/api/pii-guard/route.js";
import { CHUNK, findOffset, scanBackward, scanForward } from "../../src/lib/piiGuard/eventLog.js";
import { createSummarizer, summarize } from "../../src/lib/piiGuard/summary.js";
import { bump } from "../../src/lib/live/bus.js";

const DAY = 864e5;
const hex = (i) => i.toString(16).padStart(12, "0");
// One event a minute, oldest first, each followed by its routing record. Padding makes the file span many chunks.
function log(count, endMs, pad = 600) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(endMs - (count - i) * 60_000).toISOString();
    lines.push(JSON.stringify({ ts, requestId: `req-${i}`, model: "m", ua: "claude-cli/2", pad: "x".repeat(pad), hits: [{ hash: hex(i % 500), rule: i % 3 ? "email" : "phone", action: i % 7 ? "redact" : "leaked", source: "user/text" }] }));
    lines.push(JSON.stringify({ ts, kind: "routing", requestId: `req-${i}`, provider: `p${i % 4}`, combo: "daily" }));
  }
  return lines;
}
const parseAll = (lines) => lines.map((l) => JSON.parse(l));

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pii-log-")); paths.file = join(dir, "events.jsonl"); settings.piiGuard = { mode: "observe", rules: {}, ignore: [] }; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("event log reader", () => {
  it("bisects to the start of a range instead of reading back to it", async () => {
    const now = Date.now(), lines = log(6000, now);
    await writeFile(paths.file, lines.join("\n") + "\n");
    const handle = await open(paths.file, "r");
    try {
      const { size } = await handle.stat();
      expect(size).toBeGreaterThan(8 * CHUNK);
      const from = now - 600 * 60_000; // the last 600 events
      const start = await findOffset(handle, size, from);
      expect(start).toBeGreaterThan(size * 0.8); // most of the file is skipped
      const seen = [];
      await scanForward(handle, start, size, (e, ts) => { if (e.kind !== "routing" && ts >= from) seen.push(e.requestId); });
      expect(seen).toHaveLength(600);
      expect(seen[0]).toBe("req-5400");
      expect(seen.at(-1)).toBe("req-5999");
    } finally { await handle.close(); }
  });

  it("leaves a half-written last line for the next read", async () => {
    const lines = log(3, Date.now());
    await writeFile(paths.file, lines.join("\n") + "\n" + '{"ts":"2026');
    const handle = await open(paths.file, "r");
    try {
      let n = 0;
      const { size } = await handle.stat();
      const end = await scanForward(handle, 0, size, () => { n++; });
      expect(n).toBe(6);
      expect(end).toBe(size - '{"ts":"2026'.length);
    } finally { await handle.close(); }
  });

  it("reads newest first across chunks, merges later routing and stops when told", async () => {
    const now = Date.now(), lines = log(3000, now);
    await writeFile(paths.file, lines.join("\n") + "\n");
    const handle = await open(paths.file, "r");
    try {
      const { size } = await handle.stat();
      const got = [];
      await scanBackward(handle, size, 0, (e) => { got.push(e); return got.length < 5; });
      expect(got.map((e) => e.requestId)).toEqual(["req-2999", "req-2998", "req-2997", "req-2996", "req-2995"]);
      expect(got[0]).toMatchObject({ provider: "p3", combo: "daily" });
    } finally { await handle.close(); }
    const all = await loadEvents(now - 3001 * 60_000);
    expect(all.events).toHaveLength(3000);
    expect(all.truncated).toBe(false);
  });
});

describe("streaming summary", () => {
  it("gives the same summary as the whole-array form, with routing that arrives after its event", () => {
    const now = Date.now(), events = parseAll(log(900, now, 0));
    const opts = { since: now - 2 * DAY, until: now, now, step: 3600e3, origin: Math.floor((now - 2 * DAY) / 3600e3) * 3600e3 };
    const streamed = createSummarizer(opts);
    for (const e of events) { if (e.kind === "routing") streamed.route(e); else streamed.add(e); }
    expect(streamed.finish()).toEqual(summarize(events, opts));
  });

  it("an open-ended summarizer fed in two parts equals one fed at once", () => {
    const now = Date.now(), events = parseAll(log(400, now, 0));
    const opts = { since: now - DAY, now, step: 3600e3, origin: Math.floor((now - DAY) / 3600e3) * 3600e3, open: true };
    const feed = (s, list) => { for (const e of list) { if (e.kind === "routing") s.route(e); else s.add(e); } };
    const whole = createSummarizer(opts), parts = createSummarizer(opts);
    feed(whole, events);
    feed(parts, events.slice(0, 301));
    parts.finish({ until: now + 5000 }); // a poll in between must not disturb the state
    feed(parts, events.slice(301));
    expect(parts.finish({ until: now + 5000 })).toEqual(whole.finish({ until: now + 5000 }));
  });
});

describe("GET /api/pii-guard summary", () => {
  const url = (from, to) => `http://localhost/api/pii-guard?from=${from}&to=${to}`;

  it("a range ending in the future folds in only what was appended, and matches a fresh read", async () => {
    const now = Date.now(), lines = log(1500, now);
    await writeFile(paths.file, lines.join("\n") + "\n");
    const from = now - DAY, to = now + 3600e3;
    const first = await (await GET(new Request(url(from, to)))).json();
    expect(first.summary.requests).toBe(1440); // one event a minute, the range start included
    const extra = { ts: new Date().toISOString(), requestId: "late", hits: [{ hash: "ffffffffffff", rule: "email", action: "redact" }] };
    await appendFile(paths.file, JSON.stringify(extra) + "\n" + JSON.stringify({ ts: extra.ts, kind: "routing", requestId: "late", provider: "served" }) + "\n");
    const second = await (await GET(new Request(url(from, to)))).json();
    expect(second.summary.requests).toBe(first.summary.requests + 1);
    expect(second.summary.unique24h).toBe(first.summary.unique24h + 1);
    expect(second.summary.groups[0]).toMatchObject({ hash: "ffffffffffff", provider: "served" });
    // A different range end is a new cache key but reuses the folded state; a closed range reads the file again.
    const reused = await (await GET(new Request(url(from, to + 60_000)))).json();
    const closed = await (await GET(new Request(url(from, Date.now() - 1)))).json();
    for (const other of [reused, closed]) {
      expect(other.summary.requests).toBe(second.summary.requests);
      expect(other.summary.groups).toEqual(second.summary.groups);
      expect(other.summary.byAction).toEqual(second.summary.byAction);
    }
  });

  it("answers 304 for the same range until the pii topic moves", async () => {
    await writeFile(paths.file, log(5, Date.now()).join("\n") + "\n");
    const now = Date.now(), from = now - DAY, to = now + 3600e3;
    const first = await GET(new Request(url(from, to)));
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"pii-/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const same = await GET(new Request(url(from, to), { headers: { "if-none-match": etag } }));
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    // Another range never matches this tag.
    expect((await GET(new Request(url(from - 1000, to), { headers: { "if-none-match": etag } }))).status).toBe(200);
    bump("pii"); // what observe.js does after each append
    const moved = await GET(new Request(url(from, to), { headers: { "if-none-match": etag } }));
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(etag);
  });

  it("a settings save moves the tag too", async () => {
    await writeFile(paths.file, log(2, Date.now()).join("\n") + "\n");
    const now = Date.now(), from = now - DAY, to = now + 3600e3;
    const etag = (await GET(new Request(url(from, to)))).headers.get("etag");
    const saved = await POST(new Request("http://localhost/api/pii-guard", { method: "POST", body: JSON.stringify({ mode: "redact" }) }));
    expect(saved.status).toBe(200);
    const after = await GET(new Request(url(from, to), { headers: { "if-none-match": etag } }));
    expect(after.status).toBe(200);
    expect((await after.json()).config.mode).toBe("redact");
  });
});
