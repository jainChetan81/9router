import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

let tempDir;
let originalT3Db;
let originalHome;
let enrichSession;
let hashes;

const { DatabaseSync } = await import("node:sqlite");

function seedT3() {
  const db = new DatabaseSync(path.join(tempDir, "statev2.sqlite"));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
      default_provider TEXT, runtime_mode TEXT, interaction_mode TEXT,
      active_provider_thread_id TEXT, created_at TEXT, updated_at TEXT,
      archived_at TEXT, deleted_at TEXT, payload_json TEXT, provider_instance_id TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (
      thread_id TEXT, provider TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT, thread_id TEXT, provider TEXT, status TEXT, model TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT, thread_id TEXT, run_id TEXT, parent_node_id TEXT,
      provider TEXT, provider_thread_id TEXT, child_thread_id TEXT,
      origin TEXT, status TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT, payload_json TEXT, driver TEXT, provider_instance_id TEXT);
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT);
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT, provider_name TEXT, provider_session_id TEXT, provider_thread_id TEXT);
  `);
  const parentNative = "11111111-1111-1111-1111-111111111111";
  const childNative = "22222222-2222-2222-2222-222222222222";
  db.prepare(
    `INSERT INTO projection_projects (project_id, title, workspace_root) VALUES ('p1','9router','/home/chetan/Projects/9router')`
  ).run();
  db.prepare(
    `INSERT INTO orchestration_v2_projection_threads
     (thread_id, project_id, title, payload_json)
     VALUES ('parent-thread','p1','Deploy 9Router sticky',
       ?), ('child-thread','p1','scout run',
       ?)`
  ).run(
    JSON.stringify({ branch: "master", worktreePath: "/home/chetan/Projects/9router-wt", lineage: { parentThreadId: null } }),
    JSON.stringify({ branch: "fix/qa", worktreePath: null, lineage: { parentThreadId: "parent-thread" } })
  );
  db.prepare(
    `INSERT INTO orchestration_v2_projection_provider_threads (thread_id, provider, payload_json) VALUES ('parent-thread','claudeAgent', ?), ('child-thread','claudeAgent', ?)`
  ).run(
    JSON.stringify({ nativeThreadRef: { nativeId: parentNative } }),
    JSON.stringify({ nativeThreadRef: { nativeId: childNative } })
  );
  db.prepare(
    `INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, provider, payload_json)
     VALUES ('ps1','child-thread','claudeAgent', ?)`
  ).run(JSON.stringify({ cwd: "/home/chetan/Projects/9router" }));
  db.prepare(
    `INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, child_thread_id)
     VALUES ('sa1','parent-thread','child-thread')`
  ).run();
  db.close();
  return { parentHash: sha(`claude:${parentNative}`), childHash: sha(`claude:${childNative}`) };
}

describe("agents T3 session enrichment (N9)", () => {
  function enrichSessionReset() {
    import("@/lib/agents/enrichment.js").then((m) => m.resetEnrichmentCache?.());
  }
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-enrich-"));
    originalT3Db = process.env.T3_STATE_DB;
    originalHome = process.env.HOME;
    process.env.T3_STATE_DB = path.join(tempDir, "statev2.sqlite");
    process.env.HOME = tempDir;
    hashes = seedT3();
    ({ enrichSession } = await import("@/lib/agents/enrichment.js"));
  });
  afterEach(() => {
    process.env.T3_STATE_DB = originalT3Db;
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns only allowed fields for a matched parent session", async () => {
    const r = await enrichSession(hashes.parentHash);
    expect(r).toEqual({
      title: "Deploy 9Router sticky",
      project: "9router",
      directory: "/home/chetan/Projects/9router-wt",
      device: expect.any(String),
      parent: null,
    });
  });

  it("returns a real parent link with inferred:false for a matched child", async () => {
    const r = await enrichSession(hashes.childHash);
    expect(r.title).toBe("scout run");
    expect(r.parent).toEqual({ session: hashes.parentHash, inferred: false, parentGuessed: false });
    expect(r.directory).toBe("/home/chetan/Projects/9router");
  });

  it("fails open to null for unmatched or malformed ids", async () => {
    expect(await enrichSession("000000000000")).toBeNull();
    expect(await enrichSession("not-a-hash")).toBeNull();
    expect(await enrichSession(null)).toBeNull();
  });

  it("returns null when the T3 database is missing", async () => {
    process.env.T3_STATE_DB = path.join(tempDir, "missing.sqlite");
    const mod = await import("@/lib/agents/enrichment.js");
    // cache was built in beforeEach; reset and confirm the miss is quiet
    mod.resetEnrichmentCache();
    expect(await mod.enrichSession(hashes.parentHash)).toBeNull();
  });
});
