import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeFs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionKey } from "@/lib/agents/sessionKey.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

const previousDataDir = process.env.DATA_DIR;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-override-store-"));
process.env.DATA_DIR = tempDataDir;
let db;
let store;

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  store = await import("@/lib/agents/overrideStore.js");
});

afterAll(async () => {
  if (store) await store.flushOverrideStore().catch(() => {});
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

describe("agents override store", () => {
  it("loads lazily, validates session ids, and returns synchronous cache values", async () => {
    const session = "override-session-one";
    const input = {
      mode: "member",
      model: "openai/gpt-4o-mini",
      fallback: false,
      expiry: "session",
      revision: 0,
    };
    expect(store.isValidSession(sessionKey(session))).toBe(true);
    expect(store.isValidSession("not-a-session")).toBe(false);
    expect(store.getOverride(session, "assistant")).toBeNull();

    const saved = await store.setOverride(session, "assistant", input, {
      comboMembers: ["openai/gpt-4o-mini"],
      provider: "openai",
      actor: "dashboard",
    });
    expect(saved).toMatchObject({ mode: "member", model: "openai/gpt-4o-mini", fallback: true, revision: 1, status: "pending" });
    expect(store.getOverride(session, "assistant")).toMatchObject({ revision: 1, mode: "member" });
    expect(store.markActive(session, "assistant")).toBe(true);
    expect(store.getOverride(session, "assistant").status).toBe("active");
    await store.flushOverrideStore();
    expect(await store.listOverrides(session)).toHaveLength(1);
  });

  it("checks revisions on set and delete, then preserves a revision tombstone", async () => {
    const session = "222222222222";
    const input = {
      mode: "override",
      model: "openai/gpt-4o-mini",
      fallback: false,
      expiry: "2h",
      revision: 0,
    };
    await expect(store.setOverride(session, "assistant", { ...input, mode: "member" }, { provider: "openai" })).rejects.toMatchObject({ code: "invalid" });
    await expect(store.setOverride(session, "assistant", input, { provider: "openai", comboMembers: [] })).resolves.toMatchObject({ revision: 1 });
    await expect(store.setOverride(session, "assistant", input, { provider: "openai", comboMembers: [] })).rejects.toMatchObject({
      code: "conflict",
      currentRevision: 1,
    });
    await expect(store.deleteOverride(session, "assistant", 0)).rejects.toMatchObject({
      code: "conflict",
      currentRevision: 1,
    });
    const deleted = await store.deleteOverride(session, "assistant", 1, { actor: "dashboard" });
    expect(deleted).toMatchObject({ deleted: true, revision: 2 });
    expect(store.getOverride(session, "assistant")).toBeNull();
    expect(await store.listOverrideRevisions(session)).toEqual({ assistant: 2 });
    await expect(store.setOverride(session, "assistant", { ...input, revision: 1 }, { provider: "openai", comboMembers: [] })).rejects.toMatchObject({ currentRevision: 2 });
    await expect(store.setOverride(session, "assistant", { ...input, revision: 2 }, { provider: "openai", comboMembers: [] })).resolves.toMatchObject({ revision: 3 });
  });

  it("refreshes session expiry in memory and audits metadata only", async () => {
    const session = "333333333333";
    const saved = await store.setOverride(session, "assistant", {
      mode: "override",
      model: "openai/gpt-4o-mini",
      fallback: true,
      expiry: "session",
      revision: 0,
    }, { provider: "openai", comboMembers: [], actor: "dashboard" });
    const refreshed = store.getOverride(session, "assistant");
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(saved.expiresAt));
    await store.flushOverrideStore();

    const auditFile = path.join(tempDataDir, "agents", "overrides.jsonl");
    const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ action: "set", session, combo: "assistant", newModel: "openai/gpt-4o-mini", actor: "dashboard" });
    expect(lines.at(-1)).not.toHaveProperty("prompt");
    expect(lines.at(-1)).not.toHaveProperty("apiKey");
  });

  it("rejects fusion combos, non-members, unconfirmed expensive models, and non-OpenAI Codex targets", () => {
    const base = { session: "444444444444", combo: "assistant", fallback: true, expiry: "1h", revision: 0 };
    expect(() => store.validateOverrideInput({ ...base, combo: "thinker", mode: "override", model: "openai/gpt-4o-mini" })).toThrow(/Fusion combo/);
    expect(() => store.validateOverrideInput({ ...base, mode: "member", model: "openai/gpt-4o-mini", comboMembers: [] })).toThrow(/combo member/);
    expect(() => store.validateOverrideInput({ ...base, mode: "override", model: "cc/claude-opus-5-5", provider: "claude", comboMembers: [] })).toThrow(/confirmation/);
    expect(() => store.validateOverrideInput({ ...base, mode: "override", model: "cc/claude-sonnet-5-5", provider: "claude", comboMembers: [], isCodex: true })).toThrow(/OpenAI/);
    expect(store.validateOverrideInput({ ...base, mode: "override", model: "cc/claude-sonnet-5-5", provider: "claude", comboMembers: ["cc/claude-sonnet-5-5"], isCodex: true })).toMatchObject({ mode: "override" });
  });

  it("canonicalizes raw session identities for store reads and writes", async () => {
    const rawSession = "claude:550e8400-e29b-41d4-a716-446655440000";
    const saved = await store.setOverride(rawSession, "assistant", {
      mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedModel: "gpt-4o-mini" });
    expect(saved.session).toMatch(/^[0-9a-f]{12}$/);
    expect(store.getOverride(rawSession, "assistant")).toMatchObject({ session: saved.session });
  });

  it("fails open when a restricted key denies an override target", async () => {
    const session = "restricted-key-session";
    await store.setOverride(session, "assistant", {
      mode: "override", model: "openai/gpt-4o-mini", fallback: true, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedProvider: "openai", resolvedModel: "gpt-4o-mini" });
    const keyAccess = { _sets: { combos: new Set(["assistant"]), models: new Set() } };
    expect(store.resolveSessionOverride({
      rawSession: session,
      combo: "assistant",
      comboMembers: ["anthropic/claude-sonnet-4-20250514"],
      keyAccess,
      ua: "Claude/1.0",
    })).toBeNull();

    keyAccess._sets.models.add("openai/gpt-4o-mini");
    expect(store.resolveSessionOverride({
      rawSession: session,
      combo: "assistant",
      comboMembers: ["anthropic/claude-sonnet-4-20250514"],
      keyAccess,
      ua: "Claude/1.0",
    }).models).toEqual(["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-20250514"]);

    const previousErrors = store.getOverrideStoreErrorCount();
    const brokenContext = new Proxy({}, { get() { throw new Error("broken key context"); } });
    expect(store.resolveSessionOverride({ rawSession: session, combo: "assistant", keyAccess: brokenContext })).toBeNull();
    expect(store.getOverrideStoreErrorCount()).toBe(previousErrors + 1);
  });

  it("routes a confirmed expensive alias to its authorized concrete model", async () => {
    const session = "expensive-alias-session";
    await store.setOverride(session, "assistant", {
      mode: "override", model: "claude/opus-latest", fallback: false, expiry: "1h", revision: 0,
    }, {
      provider: "claude", resolvedProvider: "claude", resolvedModel: "claude-opus-4-1",
      confirmExpensive: true,
    });
    const result = store.resolveSessionOverride({ rawSession: session, combo: "assistant" });
    expect(result.models).toEqual(["claude/claude-opus-4-1"]);
  });

  it("uses the current request UA for Codex OpenAI-only routing", async () => {
    const session = "codex-override-session";
    await store.setOverride(session, "assistant", {
      mode: "override", model: "anthropic/claude-sonnet-4-20250514", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "anthropic", resolvedProvider: "anthropic", resolvedModel: "claude-sonnet-4-20250514" });
    expect(store.resolveSessionOverride({ rawSession: session, combo: "assistant", ua: "Codex/2.0" })).toBeNull();
    expect(store.resolveSessionOverride({ rawSession: session, combo: "assistant", ua: "Claude/2.0" }).models)
      .toEqual(["anthropic/claude-sonnet-4-20250514"]);
  });

  it("resolves only the requested override target and caches it for one TTL window", async () => {
    const modelService = await import("@/sse/services/model.js");
    const getModelInfo = vi.spyOn(modelService, "getModelInfo").mockResolvedValue({ provider: "openai", model: "gpt-4o-mini" });
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const comboRequest = (rawSession) => handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["openai/gpt-4o-mini"],
      handleSingleModel: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      log: { info() {}, warn() {}, debug() {}, error() {} },
      comboName: "assistant",
      comboStrategy: "fallback",
      rawSession,
    });
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const session = "target-ttl-session";

    await comboRequest("no-override-session");
    expect(getModelInfo).not.toHaveBeenCalled();
    await store.setOverride(session, "assistant", {
      mode: "override", model: "model-alias-for-ttl", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedProvider: "openai", resolvedModel: "gpt-4o-mini" });

    await comboRequest(session);
    await comboRequest(session);
    expect(getModelInfo).toHaveBeenCalledTimes(1);
    now += 30_001;
    await comboRequest(session);
    expect(getModelInfo).toHaveBeenCalledTimes(2);

    dateNow.mockRestore();
    getModelInfo.mockRestore();
  });

  it("reauthorizes the current alias target after an alias changes", async () => {
    const session = "alias-change-session";
    await db.setModelAlias("allowed-choice", "openai/gpt-4o-mini");
    await store.setOverride(session, "assistant", {
      mode: "override", model: "allowed-choice", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedProvider: "openai", resolvedModel: "gpt-4o-mini" });
    await db.setModelAlias("allowed-choice", "anthropic/claude-sonnet-4-20250514");
    await store.loadOverrides({ rawSession: session, combo: "assistant" });

    const keyAccess = { _sets: { combos: new Set(["assistant"]), models: new Set(["openai/gpt-4o-mini"]) } };
    expect(store.resolveSessionOverride({ rawSession: session, combo: "assistant", keyAccess })).toBeNull();
  });

  it("requires expensive confirmation when an alias resolves to an expensive model", async () => {
    const session = "alias-expensive-session";
    await db.setModelAlias("cheap-choice", "openai/gpt-4o-mini");
    await store.setOverride(session, "assistant", {
      mode: "override", model: "cheap-choice", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedProvider: "openai", resolvedModel: "gpt-4o-mini" });
    await db.setModelAlias("cheap-choice", "anthropic/claude-opus-5-5");
    await store.loadOverrides({ rawSession: session, combo: "assistant" });
    expect(store.resolveSessionOverride({ rawSession: session, combo: "assistant" })).toBeNull();
  });

  it("keeps audit failure non-fatal and hardens an existing audit file", async () => {
    const auditDir = path.join(tempDataDir, "agents");
    const auditFile = path.join(auditDir, "overrides.jsonl");
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(auditDir, 0o755);
    fs.writeFileSync(auditFile, "", { mode: 0o644 });
    fs.chmodSync(auditFile, 0o644);

    const saved = await store.setOverride("777777777777", "assistant", {
      mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedModel: "gpt-4o-mini" });
    expect(saved.auditWarning).toBeUndefined();
    expect(fs.statSync(auditDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(auditFile).mode & 0o777).toBe(0o600);

    const append = vi.mocked(nodeFs.appendFile).mockImplementationOnce((_fd, _data, _options, callback) => {
      callback(new Error("disk unavailable"));
    });
    const warning = await store.setOverride("888888888888", "assistant", {
      mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedModel: "gpt-4o-mini" });
    expect(warning).toMatchObject({ auditWarning: true, revision: 1 });
    expect(store.getOverride("888888888888", "assistant")).toMatchObject({ revision: 1 });
  });

  it("persists last-used refreshes at most once per minute per key", async () => {
    const session = "999999999991";
    await store.setOverride(session, "assistant", {
      mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "session", revision: 0,
    }, { provider: "openai", resolvedModel: "gpt-4o-mini" });
    const shared = globalThis[Symbol.for("9router.agents.overrideStore")].get(tempDataDir);
    const key = `${session}\u001fassistant`;
    const entry = shared.cache.get(key);
    const baseTime = Date.now();
    entry.lastPersistedAt = baseTime;
    shared.dirtyWrites.clear();

    vi.useFakeTimers();
    vi.setSystemTime(baseTime + 20_000);
    store.getOverride(session, "assistant");
    store.getOverride(session, "assistant");
    expect(entry.lastUsed).toBe(new Date(baseTime + 20_000).toISOString());
    expect(shared.dirtyWrites.has(key)).toBe(false);

    vi.setSystemTime(baseTime + 61_000);
    store.getOverride(session, "assistant");
    expect(shared.dirtyWrites.get(key).value.lastUsed).toBe(new Date(baseTime + 61_000).toISOString());
    vi.useRealTimers();
    await store.flushOverrideStore();
  });

  it("retries deferred KV flushes with bounded backoff", async () => {
    const session = "retry-flush-session";
    await store.setOverride(session, "assistant", {
      mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 0,
    }, { provider: "openai", resolvedModel: "gpt-4o-mini" });
    const shared = globalThis[Symbol.for("9router.agents.overrideStore")].get(tempDataDir);
    const originalSetMany = shared.kv.setMany;
    let calls = 0;
    shared.kv.setMany = async (payload) => {
      calls += 1;
      if (calls === 1) throw new Error("temporary write failure");
      return originalSetMany(payload);
    };

    vi.useFakeTimers();
    expect(store.markActive(session, "assistant")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    shared.kv.setMany = originalSetMany;
    vi.useRealTimers();
  });

  it("caps cached entries and removes tombstones older than one day", async () => {
    const shared = globalThis[Symbol.for("9router.agents.overrideStore")].get(tempDataDir);
    shared.cache.clear();
    shared.dirtyWrites.clear();
    shared.dirtyDeletes.clear();
    const now = Date.now();
    const oldSession = "ffffffffffff";
    const oldKvKey = `${oldSession}:assistant`;
    await shared.kv.set(oldKvKey, { deleted: true, revision: 2, deletedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() });
    shared.cache.set(`${oldSession}\u001fassistant`, {
      session: oldSession,
      combo: "assistant",
      deleted: true,
      revision: 2,
      deletedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });

    const baseTime = now - 5_000_000;
    for (let index = 0; index < 2001; index += 1) {
      const session = index.toString(16).padStart(12, "0");
      const timestamp = new Date(baseTime + index * 1000).toISOString();
      shared.cache.set(`${session}\u001fassistant`, {
        session,
        combo: "assistant",
        mode: "override",
        model: "openai/gpt-4o-mini",
        fallback: false,
        expiry: "1h",
        expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
        createdAt: timestamp,
        lastUsed: timestamp,
        lastPersistedAt: now,
        revision: 1,
        status: "pending",
      });
    }
    await store.flushOverrideStore();
    expect(shared.cache.size).toBe(2000);
    expect(shared.cache.has(`${oldSession}\u001fassistant`)).toBe(false);
    expect(await shared.kv.get(oldKvKey)).toBeNull();
  });

  it("retries a failed KV load after bounded backoff", async () => {
    const shared = globalThis[Symbol.for("9router.agents.overrideStore")].get(tempDataDir);
    const originalGetAll = shared.kv.getAll;
    const getAll = vi.fn().mockRejectedValueOnce(new Error("temporary read failure")).mockResolvedValueOnce({});
    shared.kv.getAll = getAll;
    shared.loaded = false;
    shared.loadPromise = null;
    shared.loadRetryAt = 0;
    shared.cache.clear();
    shared.dirtyWrites.clear();
    shared.dirtyDeletes.clear();

    vi.useFakeTimers();
    await expect(store.loadOverrides()).rejects.toThrow("temporary read failure");
    await expect(store.loadOverrides()).rejects.toThrow("temporary read failure");
    expect(getAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(store.loadOverrides()).resolves.toBeUndefined();
    expect(getAll).toHaveBeenCalledTimes(2);
    shared.kv.getAll = originalGetAll;
    vi.useRealTimers();
  });
});
