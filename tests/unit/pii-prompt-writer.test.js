import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// The scanner library lives in the separate pii-guard repo. Resolve it from
// PII_GUARD_MODULE, else this checkout's default build path; skip the suite
// (a cold CI or a fresh clone) when it is not present.
const libraryPath = process.env.PII_GUARD_MODULE || "/home/chetan/Projects/pii-guard/dist/index.js";
const describeIfLibrary = existsSync(libraryPath) ? describe : describe.skip;

const library = await import(libraryPath);
const P = await import("../../src/lib/piiGuard/prompts.js");
const D = await import("../../src/lib/piiGuard/promptDb.mjs");
const detector = library.createDetector({ salt: "abcdef0123456789" });
const exists = (f) => stat(f).then(() => true, () => false);
const capture = (text, sessionId, requestId = "r1") =>
  P.capture({ nodes: P.collect({ messages: text.map((content) => ({ role: "user", content })) }), requestId, sessionId, model: "m", client: "c" }, library, detector);

let dir, file;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pii-writer-")); file = join(dir, "prompts.db"); process.env.PII_GUARD_PROMPTS = file; await P._reset(); });
afterEach(async () => { await P._reset(); delete process.env.PII_GUARD_PROMPTS; delete process.env.PII_GUARD_PROMPTS_WORKER; await rm(dir, { recursive: true, force: true }); });

describeIfLibrary("prompt store batching", () => {
  it("capture never opens the database: nothing exists on disk until the batch is written", async () => {
    expect(capture(["first question"], null)).toBe(1);
    expect(capture(["second question"], "known-later")).toBeGreaterThan(0); // held until its digests load
    await new Promise((r) => setImmediate(r));
    expect(await exists(file)).toBe(false);
    expect(P.stats.stored).toBe(0);
    P.flush();
    expect(await exists(file)).toBe(true);
    expect(P.stats.stored).toBe(2);
  });

  it("writes on its own about a second later, in one batch", async () => {
    for (let i = 0; i < 5; i++) capture([`timer row ${i}`], null, `t${i}`);
    expect(P.stats.stored).toBe(0);
    await new Promise((r) => setTimeout(r, 1300));
    expect(P.stats.stored).toBe(5);
    expect(P.search({ q: "timer" }).rows).toHaveLength(5);
  });

  it("a session not in memory is deduplicated against the store, off the request path", async () => {
    capture(["alpha one", "alpha two"], "s1", "a1");
    P.flush();
    P._forget(); // as after a restart, or an evicted session
    capture(["alpha one", "alpha two", "alpha three"], "s1", "a2");
    expect(P.stats.stored).toBe(2);
    P.flush();
    expect(P.stats.stored).toBe(3);
    expect(P.search({ sessionId: "s1" }).rows.map((r) => r.requestId)).toEqual(["a2", "a1", "a1"]);
  });

  it("drops held requests past the bound instead of growing without limit", () => {
    for (let i = 0; i < 520; i++) capture(["held"], `session-${i}`, `h${i}`);
    expect(P.stats.dropped).toBe(20);
  });
});

describeIfLibrary("prompt store insert idempotency", () => {
  const row = (i, sessionId = "s") => ({ ts: Date.now() + i, requestId: `r${i}`, sessionId, model: null, provider: null, combo: null, account: null, client: null, role: "user", kind: "text", path: `messages[0].content`, text: `row ${i}`, cut: 0, hashes: "", digest: `dg${i}`, tool: null });

  it("a retried batch inserts nothing twice, even after a worker restart", () => {
    const h = D.openDb(file);
    const ops = [1, 2, 3].map((i) => ({ row: row(i) }));
    expect(D.writeOps(h, ops)).toMatchObject({ stored: 3 });
    // The same batch arrives again (late retry after an RPC timeout).
    expect(D.writeOps(h, ops)).toMatchObject({ stored: 0 });
    // And again from a fresh connection, as the writer thread would.
    D.closeDb(h);
    const h2 = D.openDb(file);
    expect(D.writeOps(h2, ops)).toMatchObject({ stored: 0 });
    expect(h2.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n).toBe(3);
    expect(D.textBytes(h2)).toBe(D.writeOps(h2, []).stored ? 0 : sum2(h2));
  });

  const sum2 = (h) => Number(h.db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM messages").get().n);

  it("pre-existing duplicates are deduped before the unique index is created", () => {
    const h = D.openDb(file);
    const ops = [1, 2, 3].map((i) => ({ row: row(i) }));
    D.writeOps(h, ops);
    D.closeDb(h);
    // Simulate a database from an even older build: no unique index yet and a
    // duplicate row inside. Drop the index, duplicate a row, then reopen.
    const raw = D.openDb(file);
    raw.db.exec("DROP INDEX IF EXISTS messages_dedupe");
    raw.db.exec(`INSERT INTO messages (ts, request_id, session_id, role, kind, path, text, cut, hashes, digest)
      SELECT ts, request_id, session_id, role, kind, path, text, cut, hashes, digest FROM messages LIMIT 1`);
    D.closeDb(raw);
    const h2 = D.openDb(file); // runs the dedupe-then-index migration
    expect(h2.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n).toBe(3);
    D.closeDb(h2);
  });
});

describeIfLibrary("prompt store retention", () => {
  const fill = (h, n, size, ts = Date.now()) => D.writeOps(h, Array.from({ length: n }, (_, i) => ({ row: { ts: ts + i, requestId: `r${i}`, sessionId: "s", model: null, provider: null, combo: null, account: null, client: null, role: "user", kind: "text", path: "p", text: `w${i} `.repeat(Math.ceil(size / 6)).slice(0, size), cut: 0, hashes: "", digest: `d${i}`, tool: null } })));
  const sum = (h) => Number(h.db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM messages").get().n);

  it("keeps a byte counter equal to the stored text through inserts, expiry and eviction", () => {
    const h = D.openDb(file);
    fill(h, 50, 2000, Date.now() - 20 * 864e5); // already expired
    fill(h, 200, 2000);
    expect(D.textBytes(h)).toBe(sum(h));
    expect(D.sweep(h).removed).toBe(50);
    expect(D.textBytes(h)).toBe(sum(h));
    D.sweep(h, Date.now(), { capBytes: 150_000 });
    expect(D.textBytes(h)).toBe(sum(h));
    D.closeDb(h);
  });

  it("evicts the oldest rows until text and file are under the cap", () => {
    const h = D.openDb(file);
    fill(h, 600, 4000);
    const cap = 1024 * 1024;
    expect(D.usedBytes(h)).toBeGreaterThan(cap);
    const { removed } = D.sweep(h, Date.now(), { capBytes: cap });
    expect(removed).toBeGreaterThan(0);
    expect(D.textBytes(h)).toBeLessThanOrEqual(cap);
    expect(D.usedBytes(h)).toBeLessThanOrEqual(cap);
    const left = h.db.prepare("SELECT MIN(request_id) AS oldest, COUNT(*) AS n FROM messages").get();
    expect(Number(left.n)).toBe(600 - removed);
    expect(h.db.prepare("SELECT 1 FROM messages WHERE request_id = 'r0'").get()).toBeUndefined(); // oldest went first
    expect(h.db.prepare("SELECT 1 FROM messages WHERE request_id = 'r599'").get()).toBeDefined();
    // Search no longer finds an evicted row.
    expect(D.search(h, { q: "w0" }).rows).toEqual([]);
    D.closeDb(h);
  });

  it("works in slices under a time budget and reports what is left", () => {
    const h = D.openDb(file);
    fill(h, 900, 500, Date.now() - 20 * 864e5);
    const first = D.sweep(h, Date.now(), { budgetMs: 0, chunk: 100 });
    expect(first).toMatchObject({ removed: 100, more: true });
    let more = true, rounds = 0;
    while (more && rounds++ < 50) more = D.sweep(h, Date.now(), { budgetMs: 0, chunk: 100 }).more;
    expect(Number(h.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n)).toBe(0);
    expect(D.textBytes(h)).toBe(0);
    D.closeDb(h);
  });
});

describeIfLibrary("prompt store writer thread", () => {
  it("stores, deduplicates after a restart, searches and sweeps without a main-thread connection", async () => {
    process.env.PII_GUARD_PROMPTS_WORKER = "on";
    capture(["worker one", "worker two"], "ws", "w1");
    await P.flush();
    expect(P.stats).toMatchObject({ stored: 2, errors: 0 });
    P._forget();
    capture(["worker one", "worker two", "worker three"], "ws", "w2");
    P.updateRouting("w2", { provider: "prov", combo: "daily", account: "acc" }, detector);
    await P.flush();
    expect(P.stats.stored).toBe(3);
    const rows = (await P.searchAsync({ q: "worker" })).rows;
    expect(rows.map((r) => r.requestId)).toEqual(["w2", "w1", "w1"]);
    expect(rows[0]).toMatchObject({ provider: "prov", combo: "daily", account: "acc" });
    expect((await P.conversationAsync({ sessionId: "ws" })).messages.total).toBe(3);
    expect(await P.messageAsync(rows[0].id)).toMatchObject({ text: "worker three" });
    expect(await P.sweepAsync(Date.now() + 15 * 864e5)).toBe(3);
    expect((await P.searchAsync({})).rows).toEqual([]);
  });
});
