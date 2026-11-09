import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const library = await import("/home/chetan/Projects/pii-guard/dist/index.js");
const P = await import("../../src/lib/piiGuard/prompts.js");
const detector = library.createDetector({ known: [{ name: "pin", value: "zx81" }], salt: "abcdef0123456789" });
const pan = ["ABCPE", "1234", "F"].join(""), mail = ["priya.sharma", "corpmail.in"].join("@");
let dir;
const tick = () => new Promise((r) => setImmediate(r));
async function run(body, sessionId = "s1", requestId = "r1", routing = {}) {
  P.capture({ nodes: P.collect(body), requestId, sessionId, model: "m", client: "Claude Code", ...routing }, library, detector);
  await tick(); P.flush();
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pii-prompts-")); process.env.PII_GUARD_PROMPTS = join(dir, "c", "prompts.db"); P._reset(); });
afterEach(async () => { P._reset(); delete process.env.PII_GUARD_PROMPTS; await rm(dir, { recursive: true, force: true }); });

describe("prompt store", () => {
  it("stores masked text, searchable by any word, with no raw value on disk", async () => {
    await run({ system: "You are helpful", messages: [{ role: "user", content: `Repeat this to me: PAN ${pan}, mail ${mail}, pin zx81. Where should I store personal information?` }] });
    const { rows } = P.search({ q: "repeat this" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: "r1", sessionId: "s1", role: "user", client: "Claude Code" });
    const m = P.message(rows[0].id);
    expect(m.text).toContain("•••••@corpmail.in");
    expect(P.search({ q: "personal informat" }).rows).toHaveLength(1);
    expect(P.search({ q: "helpful" }).rows[0].role).toBe("system");
    const raw = (await readFile(process.env.PII_GUARD_PROMPTS)).toString("latin1") + await readFile(`${process.env.PII_GUARD_PROMPTS}-wal`).then((b) => b.toString("latin1")).catch(() => "");
    for (const v of [pan, mail, "zx81"]) expect(raw).not.toContain(v);
    expect((await stat(process.env.PII_GUARD_PROMPTS)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "c"))).mode & 0o777).toBe(0o700);
  });
  it("stores only new messages per session, and links findings by hash", async () => {
    const turn1 = [{ role: "user", content: "first question" }];
    await run({ system: "sys", messages: turn1 }, "s1", "r1");
    await run({ system: "sys", messages: [...turn1, { role: "assistant", content: "answer" }, { role: "user", content: `second ${pan}` }] }, "s1", "r2");
    const r2 = P.search({ requestId: "r2" }).rows;
    expect(r2.map((r) => P.message(r.id).text).sort()).toEqual(["answer", "second AB•••••F"]);
    expect(P.search({ sessionId: "s1" }).rows).toHaveLength(4);
    const h = detector.scan(pan)[0].hash;
    expect(P.search({ hash: h }).rows.map((r) => r.requestId)).toEqual(["r2"]);
    await run({ system: "sys", messages: [...turn1, { role: "user", content: `second ${pan}` }, { role: "user", content: "third" }] }, "s1", "r3");
    expect(P.search({ requestId: "r3" }).rows.map((r) => P.message(r.id).text)).toEqual(["third"]);
  });
  it("after a restart, a running session does not store its history again", async () => {
    const turn1 = [{ role: "user", content: "first question" }];
    await run({ messages: turn1 }, "s9", "a1");
    P._forget();
    await run({ messages: [...turn1, { role: "user", content: "second question" }] }, "s9", "a2");
    expect(P.search({ requestId: "a2" }).rows.map((r) => P.message(r.id).text)).toEqual(["second question"]);
  });
  it("without a session keeps the latest message only", async () => {
    await run({ messages: [{ role: "user", content: "old turn" }, { role: "user", content: "new turn" }] }, null);
    expect(P.search({}).rows.map((r) => P.message(r.id).text)).toEqual(["new turn"]);
  });
  it("collects tool calls and results, skips thinking", () => {
    const nodes = P.collect({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "secret plan", signature: "s" }, { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "files" }] }] });
    expect(nodes.map((n) => [n.kind, n.text, n.tool])).toEqual([["tool_use", 'Bash {"cmd":"ls"}', "Bash"], ["tool_result", "files", "Bash"]]);
  });
  it("names tool_calls and paired function_call outputs by tool name", () => {
    const nodes = P.collect({ input: [
      { type: "function_call", call_id: "c1", name: "weather", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "sunny" },
      { role: "assistant", tool_calls: [{ function: { name: "calc", arguments: "1" } }] },
    ] });
    expect(nodes.map((n) => [n.kind, n.tool])).toEqual([["tool_use", "weather"], ["tool_result", "weather"], ["tool_use", "calc"]]);
  });
  it("stores tool names and routing fields, and migrates a schema without them", async () => {
    await run({ messages: [{ role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }] }] }, "s1", "r1", { provider: "anthropic", combo: "daily", account: "acc-1" });
    const row = P.search({ requestId: "r1" }).rows[0];
    expect(P.message(row.id)).toMatchObject({ tool: "Bash", provider: "anthropic", combo: "daily", account: "acc-1" });
    // Migration: drop the new columns from a copy and reopen; old rows keep working, new ones store again.
    // Reset first so WAL is checkpointed and the copy holds all rows.
    P._reset();
    const file = process.env.PII_GUARD_PROMPTS;
    const old = file.replace(".db", "-old.db");
    await writeFile(old, await readFile(file));
    process.env.PII_GUARD_PROMPTS = old;
    P._reset();
    const check = await import("node:sqlite");
    const before = new check.DatabaseSync(old);
    // Rebuild without the new columns: create plain (id loses its PK → re-added by copying
    // rows around so later inserts still get rowids).
    before.exec("CREATE TABLE plain (ts INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT, model TEXT, client TEXT, role TEXT, kind TEXT, path TEXT, text TEXT NOT NULL, cut INTEGER NOT NULL, hashes TEXT NOT NULL, digest TEXT); INSERT INTO plain SELECT ts, request_id, session_id, model, client, role, kind, path, text, cut, hashes, digest FROM messages; DROP TABLE messages; CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT, model TEXT, client TEXT, role TEXT, kind TEXT, path TEXT, text TEXT NOT NULL, cut INTEGER NOT NULL, hashes TEXT NOT NULL, digest TEXT); INSERT INTO messages (ts, request_id, session_id, model, client, role, kind, path, text, cut, hashes, digest) SELECT ts, request_id, session_id, model, client, role, kind, path, text, cut, hashes, digest FROM plain; DROP TABLE plain;");
    before.close();
    await run({ messages: [{ role: "user", content: "new after migration" }] }, "s1", "r2", { provider: "p2" });
    const old2 = P.search({ requestId: "r1" }).rows[0];
    // Old rows stay NULL for the new columns; text and hashes still read.
    expect(P.message(old2.id)).toMatchObject({ text: 'Bash {"cmd":"ls"}', provider: null, tool: null });
    expect(P.message(P.search({ requestId: "r2" }).rows[0].id)).toMatchObject({ text: "new after migration", tool: null, provider: "p2" });
  });
  it("stores tool names from OpenAI tool_calls, and pairs tool-role results by tool_call_id", () => {
    const nodes = P.collect({ messages: [
      { role: "assistant", tool_calls: [
        { id: "call_a", function: { name: "parallel_one", arguments: "1" } },
        { id: "call_b", function: { name: "parallel_two", arguments: "2" } },
      ] },
      { role: "tool", tool_call_id: "call_b", content: "two done" },
      { role: "tool", tool_call_id: "call_a", content: [{ type: "text", text: "one done" }] },
      { role: "tool", tool_call_id: "call_missing", content: "unpaired" },
    ] });
    expect(nodes.map((n) => [n.kind, n.tool])).toEqual([
      ["tool_use", "parallel_one"], ["tool_use", "parallel_two"],
      ["tool_result", "parallel_two"], ["tool_result", "parallel_one"],
      ["tool_result", undefined],
    ]);
  });
  it("pairs Anthropic tool_result arrays and blocks whose name came earlier", () => {
    const nodes = P.collect({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "file body" }] },
      ] },
    ] });
    expect(nodes.filter((n) => n.kind === "tool_result").map((n) => n.tool)).toEqual(["Read"]);
  });
  it("fails routing fields closed: a detector hit or an @ never lands, valid ids do", async () => {
    const secret = "synthetic-own-value-739201";
    const det = library.createDetector({ known: [{ name: "secret", value: secret }], salt: "abcdef0123456789" });
    await run({ messages: [{ role: "user", content: "hi" }] }, "s1", "r10", { provider: "good-provider", combo: "daily/combo.v2", account: mail, tool: `bash ${secret}` });
    const m = P.message(P.search({ requestId: "r10" }).rows[0].id);
    expect(m).toMatchObject({ provider: "good-provider", combo: "daily/combo.v2", account: null, tool: null });
    expect(!m.account || !m.account.includes("@")).toBe(true);
    expect(m.text).not.toContain(secret);
  });
  it("a failing migration leaves the store closed instead of failing every insert", async () => {
    // Old schema without the routing columns, on a read-only file: ALTER fails and open() gives up.
    const file = join(dir, "ro", "old.db");
    await import("node:fs").then(async (fs) => {
      fs.mkdirSync(join(dir, "ro"), { mode: 0o700 });
      const sql = new (await import("node:sqlite")).DatabaseSync(file);
      sql.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT, model TEXT, client TEXT, role TEXT, kind TEXT, path TEXT, text TEXT NOT NULL, cut INTEGER NOT NULL, hashes TEXT NOT NULL, digest TEXT)");
      sql.exec("INSERT INTO messages (ts, request_id, text, cut, hashes) VALUES (1, 'x', 'kept row', 0, '')");
      sql.close();
      fs.chmodSync(file, 0o400);
    });
    process.env.PII_GUARD_PROMPTS = file;
    P._reset();
    try {
      await run({ messages: [{ role: "user", content: "new row" }] }, "s5", "r5");
      const r = P.search({ q: "kept" });
      expect(r.unavailable).toBe(true); // the connection is not used: status reads, writes do not happen
      expect(P.search({ q: "new row" }).rows).toEqual([]);
    } finally {
      await import("node:fs").then((fs) => { fs.chmodSync(file, 0o600); });
      process.env.PII_GUARD_PROMPTS = join(dir, "c", "prompts.db");
      P._reset();
    }
  });
  it("a prompt-row tool name goes through the same fail-closed validation as the account", async () => {
    await run({ messages: [{ role: "assistant", content: [{ type: "tool_use", name: "weird name!!", input: {} }] }, { role: "user", content: "latest" }] }, "s1", "r11", { tool: "weird name!!" });
    await tick(); P.flush();
    const m = P.message(P.search({ requestId: "r11" }).rows[0].id);
    expect(m.tool).toBeNull();
  });
  it("wraps the account label: an email never stored", async () => {
    await run({ messages: [{ role: "user", content: "clean this" }] }, "s1", "r9", { account: mail });
    const m = P.message(P.search({ requestId: "r9" }).rows[0].id);
    expect(m.account === null || m.account === undefined).toBe(true);
    expect(m.text).toBe("clean this");
  });
  it("caps tool output and pages results", async () => {
    await run({ messages: [{ role: "tool", content: "x ".repeat(P.TOOL_CAP) }] });
    expect(P.message(P.search({}).rows[0].id).cut).toBe(1);
    for (let i = 0; i < 3; i++) await run({ messages: [{ role: "user", content: `page word ${i}` }] }, "s2", `p${i}`);
    const a = P.search({ q: "page", limit: 2 });
    expect(a.rows).toHaveLength(2);
    expect(P.search({ q: "page", limit: 2, before: a.next }).rows).toHaveLength(1);
  });
  it("search input cannot inject FTS syntax", () => {
    expect(() => P.search({ q: 'a" OR NEAR(b' })).not.toThrow();
    expect(P.search({ q: "***" }).rows).toEqual([]);
  });
  it("observeRequest stores the original prompt masked, with session, while the body is still redacted", async () => {
    process.env.PII_GUARD_MODULE = "/home/chetan/Projects/pii-guard/dist/index.js";
    process.env.PII_GUARD_KNOWN = join(dir, "known.json");
    await writeFile(process.env.PII_GUARD_KNOWN, JSON.stringify({ version: 1, salt: "abcdef0123456789", items: [] }));
    try {
      const { observeRequest } = await import("../../src/lib/piiGuard/observe.js");
      const body = { model: "m", messages: [{ role: "user", content: `Repeat this to me: ${mail}` }] };
      await observeRequest(body, { endpoint: "/v1/messages", userAgent: "claude-cli/2", sessionId: "claude:abc" }, { mode: "redact", rules: {} });
      expect(body.messages[0].content).toMatch(/^Repeat this to me: \{\{pii:email#[0-9a-f]{6}\}\}$/);
      await new Promise((r) => setTimeout(r, 150)); // the deferred write settles
      P.flush();
      const [row] = P.search({ q: "repeat" }).rows;
      expect(row).toMatchObject({ sessionId: expect.stringMatching(/^[0-9a-f]{24}$/), client: "Claude Code" });
      expect(P.message(row.id).text).toBe("Repeat this to me: •••••@corpmail.in");
    } finally { delete process.env.PII_GUARD_MODULE; delete process.env.PII_GUARD_KNOWN; }
  });
  it("never stores a value the request scan found only through sibling context, or a client role", async () => {
    process.env.PII_GUARD_MODULE = "/home/chetan/Projects/pii-guard/dist/index.js";
    process.env.PII_GUARD_KNOWN = join(dir, "known.json");
    await writeFile(process.env.PII_GUARD_KNOWN, JSON.stringify({ version: 1, salt: "abcdef0123456789", items: [] }));
    try {
      const { observeRequest } = await import("../../src/lib/piiGuard/observe.js");
      const num = ["98765", "43210"].join("");
      expect(detector.scan(num)).toEqual([]); // bare string: no keyword, no finding
      const body = { model: "m", messages: [{ role: `user ${pan}`, label: "mobile", content: num }, { role: "user", content: "latest turn" }] };
      await observeRequest(body, { endpoint: "/v1/messages", userAgent: "x/1", sessionId: "raw-session" }, { mode: "observe", rules: {} });
      await tick(); P.flush();
      const rows = P.search({}).rows;
      const all = rows.map((r) => JSON.stringify(P.message(r.id))).join(" ");
      for (const v of [num, pan, "raw-session"]) expect(all).not.toContain(v);
      expect(rows.every((r) => /^[0-9a-f]{24}$/.test(r.sessionId))).toBe(true);
    } finally { delete process.env.PII_GUARD_MODULE; delete process.env.PII_GUARD_KNOWN; }
  });
  it("drops context-only values in every body shape, including repeats inside tool input", async () => {
    process.env.PII_GUARD_MODULE = "/home/chetan/Projects/pii-guard/dist/index.js";
    process.env.PII_GUARD_KNOWN = join(dir, "known.json");
    await writeFile(process.env.PII_GUARD_KNOWN, JSON.stringify({ version: 1, salt: "abcdef0123456789", items: [] }));
    try {
      const { observeRequest } = await import("../../src/lib/piiGuard/observe.js");
      const num = ["98765", "43210"].join(""), num2 = ["91234", "56780"].join("");
      const bodies = [
        { model: "m", label: "mobile", input: num },
        { model: "m", label: "mobile", instructions: num, input: [{ role: "user", content: "hi" }] },
        { model: "m", label: "mobile", system: num, messages: [{ role: "user", content: "hi" }] },
        { model: "m", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: { first: `mobile ${num}`, padding: "x".repeat(100), value: num } }] }] },
        { model: "m", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: { first: `mobile ${num}`, padding: "x".repeat(100), value: num2 } }] }] },
      ];
      for (const [i, body] of bodies.entries()) await observeRequest(body, { endpoint: "/v1/messages", userAgent: "x/1", sessionId: `s${i}` }, { mode: "observe", rules: {} });
      await new Promise((r) => setTimeout(r, 150)); // the deferred write settles
      P.flush();
      const all = P.search({}).rows.map((r) => P.message(r.id).text).join(" ");
      for (const v of [num, num2]) expect(all).not.toContain(v);
      expect(P.stats.unsafe).toBeGreaterThan(0); // unsafe nodes are dropped and counted, never stored
    } finally { delete process.env.PII_GUARD_MODULE; delete process.env.PII_GUARD_KNOWN; }
  });
  it("retries a digest after the first database write fails", async () => {
    const good = process.env.PII_GUARD_PROMPTS;
    process.env.PII_GUARD_PROMPTS = "/dev/null/prompts.db";
    await run({ messages: [{ role: "user", content: "retry this prompt" }] });
    P._reset();
    process.env.PII_GUARD_PROMPTS = good;
    await run({ messages: [{ role: "user", content: "retry this prompt" }] });
    expect(P.search({ q: "retry" }).rows).toHaveLength(1);
  });
  it("deletes rows older than 14 days", async () => {
    await run({ messages: [{ role: "user", content: "old" }] });
    expect(P.sweep(Date.now() + 15 * 864e5)).toBe(1);
    expect(P.search({ q: "old" }).rows).toEqual([]);
  });
});

describe("coverage guard", () => {
  it("drops a node when the request scan saw more hits than the node rescan masks", async () => {
    const lib = { ...library, maskText: (t) => t }; // a masker that misses everything
    const plain = library.createDetector({ salt: "abcdef0123456789" });
    const quiet = { ...plain, scan: () => [] }; // rescan sees nothing, like a context-only value
    P.capture({ nodes: [{ text: "value 9876543210", role: "user", kind: "text", path: "messages[0].content" }], bodyFindings: [{ path: "messages[0].content.x", start: 0, end: 1, hash: "aaaaaaaaaaaa", rule: "in_phone", kind: "pii" }], requestId: "g", sessionId: "s", model: "m", client: "c" }, lib, quiet);
    await new Promise((r) => setImmediate(r)); P.flush();
    expect(P.stats.unsafe).toBe(1);
    expect(P.search({}).rows).toEqual([]);
  });
});


describe("metadata validation and routing updates", () => {
  it.each(["name@example.test", "sk-ant-" + "Q1w2E3r4T5y6U7i8O9p0AsDf"])("drops unsafe collected tool names: %s", async tool => {
    await run({ input: [
      { type: "function_call", call_id: "c1", name: tool, arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ordinary tool output" },
    ] });
    const rows = P.search({ requestId: "r1" }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.tool === null)).toBe(true);
  });

  it("drops each identifier on detector exceptions and accepts the exact charset", () => {
    const throwing = { scan() { throw Error("detector unavailable"); } };
    expect(P.cleanId("valid-id", throwing)).toBeNull();
    expect(P.cleanId("valid-id", null)).toBeNull();
    expect(P.cleanId("route/a+b:c.d_e-f", detector)).toBe("route/a+b:c.d_e-f");
    for (const value of ["name@example.test", "white space", "back\\slash", "a".repeat(65), 123]) expect(P.cleanId(value, detector)).toBeNull();
  });

  it("validates collected tool names when their detector throws", async () => {
    const det = { scan(text) { if (text === "bad-tool") throw Error("failed"); return []; } };
    P.capture({ nodes: [{ text: "ordinary output", role: "tool", kind: "tool_result", path: "input", tool: "bad-tool" }], requestId: "r1" }, library, det);
    P.flush();
    expect(P.search({ requestId: "r1" }).rows[0].tool).toBeNull();
  });

  it("updates both queued and persisted prompts without retaining rejected labels", async () => {
    P.capture({ nodes: P.collect({ input: "ordinary output" }), requestId: "r1" }, library, detector);
    P.updateRouting("r1", { provider: "first", combo: "daily", account: "work" }, detector);
    P.flush();
    expect(P.search({ requestId: "r1" }).rows[0]).toMatchObject({ provider: "first", combo: "daily", account: "work" });
    P.updateRouting("r1", { provider: "last", combo: "daily", account: "name@example.test" }, detector);
    expect(P.search({ requestId: "r1" }).rows[0]).toMatchObject({ provider: "last", combo: "daily", account: null });
  });

  it("continues migration after another opener adds only one missing column", async () => {
    const file = process.env.PII_GUARD_PROMPTS;
    const fs = await import("node:fs");
    fs.mkdirSync(join(dir, "c"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT, model TEXT, client TEXT, role TEXT, kind TEXT, path TEXT, text TEXT NOT NULL, cut INTEGER NOT NULL DEFAULT 0, hashes TEXT NOT NULL DEFAULT '', digest TEXT)");
    old.close();
    const original = DatabaseSync.prototype.exec;
    let raced = false;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(sql) {
      if (!raced && sql === "ALTER TABLE messages ADD COLUMN provider TEXT") {
        raced = true;
        original.call(this, sql);
        throw Error("duplicate column name: provider");
      }
      return original.call(this, sql);
    });
    try {
      await run({ input: "after migration" }, "s1", "r1", { provider: "p", combo: "daily", account: "work" });
      expect(raced).toBe(true);
      expect(P.search({ requestId: "r1" }).rows[0]).toMatchObject({ provider: "p", combo: "daily", account: "work", tool: null });
    } finally { spy.mockRestore(); }
  });
});
