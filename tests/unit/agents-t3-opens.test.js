// T3 enrichment opens the T3 SQLite file at most once per poll, and not at
// all while the index and thread facts are cached.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

globalThis.__t3Opens = 0;
vi.mock("node:sqlite", async (importOriginal) => {
  const mod = await importOriginal();
  class CountingDatabaseSync extends mod.DatabaseSync {
    constructor(file, options) {
      super(file, options);
      if (options?.readOnly) globalThis.__t3Opens++;
    }
  }
  return { ...mod, default: { ...mod, DatabaseSync: CountingDatabaseSync }, DatabaseSync: CountingDatabaseSync };
});

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const natives = Array.from({ length: 6 }, (_, i) => `0000000${i}-1111-1111-1111-111111111111`);
const hashes = natives.map((id) => sha(`claude:${id}`));

let tempDir;
const originalT3Db = process.env.T3_STATE_DB;
let enrichment;
let queries;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-t3opens-"));
  process.env.T3_STATE_DB = path.join(tempDir, "statev2.sqlite");
  const { DatabaseSync } = await vi.importActual("node:sqlite");
  const db = new DatabaseSync(process.env.T3_STATE_DB);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, provider TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, child_thread_id TEXT);
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT, provider_name TEXT, provider_session_id TEXT, provider_thread_id TEXT);
    INSERT INTO projection_projects VALUES ('p1', '9router', '/srv/9router');
  `);
  natives.forEach((nativeId, i) => {
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'p1', ?, ?)").run(`t${i}`, `Thread ${i}`, JSON.stringify({ worktreePath: `/srv/wt${i}` }));
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, 'claudeAgent', ?)").run(`t${i}`, JSON.stringify({ nativeThreadRef: { nativeId } }));
  });
  // A broken payload must not break the index.
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('bad', 'claudeAgent', '{not json')").run();
  db.close();
  enrichment = await import("@/lib/agents/enrichment.js");
  queries = await import("@/lib/agents/queries.js");
});

afterAll(() => {
  if (originalT3Db === undefined) delete process.env.T3_STATE_DB; else process.env.T3_STATE_DB = originalT3Db;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => { enrichment.resetEnrichmentCache(); globalThis.__t3Opens = 0; });

describe("agents T3 enrichment connections", () => {
  it("enriches a whole page of sessions with one open", async () => {
    const out = await enrichment.enrichSessions(hashes);
    expect(globalThis.__t3Opens).toBe(1);
    expect(out.size).toBe(6);
    expect(out.get(hashes[3])).toMatchObject({ title: "Thread 3", project: "9router", directory: "/srv/wt3", parent: null });
  });

  it("opens nothing on later polls while the caches are warm", async () => {
    await enrichment.enrichSessions(hashes);
    globalThis.__t3Opens = 0;
    for (let poll = 0; poll < 10; poll++) {
      const out = await enrichment.enrichSessions(hashes);
      expect(out.get(hashes[0]).title).toBe("Thread 0");
      expect(await enrichment.enrichSession(hashes[1])).toMatchObject({ title: "Thread 1" });
    }
    expect(globalThis.__t3Opens).toBe(0);
  });

  it("opens once when a new session joins a warm poll", async () => {
    await enrichment.enrichSessions(hashes.slice(0, 3));
    globalThis.__t3Opens = 0;
    const out = await enrichment.enrichSessions(hashes);
    expect(globalThis.__t3Opens).toBe(1);
    expect(out.get(hashes[5]).title).toBe("Thread 5");
  });

  it("opens once per poll after the cache lifetime ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await enrichment.enrichSessions(hashes);
      globalThis.__t3Opens = 0;
      vi.setSystemTime(Date.now() + 61_000);
      await enrichment.enrichSessions(hashes);
      expect(globalThis.__t3Opens).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("a /live poll over several sessions opens T3 once, the next poll not at all", async () => {
    const now = Date.now();
    const db = {
      driver: "sql.js",
      all(text) {
        if (text === "PRAGMA table_info(usageHistory)") return [{ name: "session" }];
        return hashes.map((sess, i) => ({ sess, timestamp: new Date(now - 1000 * (i + 1)).toISOString(), role: "direct", model: "m", ok: 1, ua: "claude-cli/2.1", hasLatency: 0, totalMs: null, ttftMs: null, stream: null, completionTokens: 0 }));
      },
    };
    const first = await queries.getLive(db, now);
    expect(first.sessions.map((s) => s.title)).toEqual(hashes.map((_, i) => `Thread ${i}`));
    expect(globalThis.__t3Opens).toBe(1);
    globalThis.__t3Opens = 0;
    await queries.getLive(db, now + 2000);
    expect(globalThis.__t3Opens).toBe(0);
  });

  it("answers without opening anything when no id is a session hash", async () => {
    expect((await enrichment.enrichSessions(["nope", null, ""])).size).toBe(0);
    expect(globalThis.__t3Opens).toBe(0);
  });
});
