import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-history-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function getUsageModules() {
  const [{ getAdapter }, { saveUsageStats, saveFailureUsage }, { saveRequestUsage }] = await Promise.all([
    import("@/lib/db/driver.js"),
    import("../../open-sse/handlers/chatCore/requestDetail.js"),
    import("@/lib/db/repos/usageRepo.js"),
  ]);
  return { adapter: await getAdapter(), saveUsageStats, saveFailureUsage, saveRequestUsage };
}

describe("usageHistory additions", () => {
  it("stores latency, status, and reqId on success", async () => {
    const { adapter, saveUsageStats } = await getUsageModules();
    const clientRawRequest = {
      reqId: "logical-request-1",
      usageStartedAt: performance.now() - 30,
      session: "client-session-id",
      combo: "workers",
      usageTarget: { provider: "openai", model: "gpt-4o" },
      body: { stream: false },
      headers: { "user-agent": "unit-test-client" },
    };

    await saveUsageStats({
      provider: "openai",
      model: "gpt-test",
      tokens: { prompt_tokens: 7, completion_tokens: 3 },
      clientRawRequest,
      latency: { ttftMs: null, totalMs: 30, stream: false },
      silent: true,
    });

    const row = adapter.get(`SELECT status, meta FROM usageHistory LIMIT 1`);
    const meta = JSON.parse(row.meta);
    expect(row.status).toBe("ok");
    expect(meta).toMatchObject({
      reqId: "logical-request-1",
      status: "ok",
      latency: { ttftMs: null, totalMs: 30, stream: false },
      combo: "workers",
      ua: "unit-test-client",
    });
  }, 15000);

  it("keeps an upstream-accepted unregistered model and its normal cost on success", async () => {
    const [{ adapter, saveUsageStats }, pricing] = await Promise.all([
      getUsageModules(),
      import("open-sse/providers/pricing.js"),
    ]);
    const model = "gpt-4o-future-2026-11";
    const tokens = { prompt_tokens: 1000, completion_tokens: 500 };
    const modelInfo = await import("open-sse/config/providerModels.js");
    expect(modelInfo.isValidModel("openai", model)).toBe(false);
    const masterPrice = pricing.getPricingForModel("openai", model);
    expect(masterPrice).not.toBeNull();

    await saveUsageStats({
      provider: "openai",
      model,
      tokens,
      clientRawRequest: {
        reqId: "unregistered-upstream-model",
        usageTarget: { provider: "openai", model: "invalid" },
        headers: {},
      },
      silent: true,
    });

    const row = adapter.get("SELECT provider, model, cost FROM usageHistory LIMIT 1");
    expect(row).toMatchObject({ provider: "openai", model });
    expect(row.cost).toBeCloseTo(pricing.calculateCostFromTokens(tokens, masterPrice), 12);
  }, 15000);

  it("records validated early failure targets without storing unknown client models", async () => {
    const { adapter, saveFailureUsage } = await getUsageModules();
    await saveFailureUsage({ provider: "openai", model: "gpt-4o", statusCode: 403,
      clientRawRequest: { body: { model: "gpt-4o" }, usageTarget: { provider: null, model: "invalid" } } });
    await saveFailureUsage({ provider: null, model: "invalid", statusCode: 403,
      clientRawRequest: { body: { model: "private-unknown-model" } } });
    const rows = adapter.all("SELECT provider, model FROM usageHistory ORDER BY rowid");
    expect(rows).toMatchObject([{ provider: "openai", model: "gpt-4o" }, { provider: "unknown", model: "invalid" }]);
  });

  it("writes failure rows without messages or request text", async () => {
    const { adapter, saveFailureUsage } = await getUsageModules();
    const clientRawRequest = {
      reqId: "logical-request-failed",
      usageStartedAt: performance.now() - 10,
      session: "client-session-id",
      combo: "workers",
      endpoint: "/v1/chat/completions",
      body: { stream: true, messages: [{ role: "user", content: "private prompt text" }] },
      headers: { "user-agent": "unit-test-client" },
    };

    await saveFailureUsage({
      provider: "anthropic",
      model: "claude-test",
      apiKey: "valid-test-key",
      clientRawRequest,
      statusCode: 503,
      error: new Error("private upstream message"),
      stream: true,
    });
    await saveFailureUsage({
      provider: "anthropic",
      model: "claude-test",
      apiKey: "valid-test-key",
      clientRawRequest,
      statusCode: 504,
      error: new Error("second terminal outcome"),
      stream: true,
    });

    const row = adapter.get(`SELECT status, apiKey, provider, model, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory LIMIT 1`);
    expect(row).toMatchObject({ status: "503", apiKey: "valid-test-key", provider: "anthropic", model: "claude-test", promptTokens: 0, completionTokens: 0, cost: 0 });
    expect(JSON.parse(row.tokens)).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
    const meta = JSON.parse(row.meta);
    expect(meta).toMatchObject({
      reqId: "logical-request-failed",
      status: "error",
      errorKind: "upstream_5xx",
      combo: "workers",
      ua: "unit-test-client",
      latency: { stream: true, ttftMs: null },
    });
    expect(meta.latency.totalMs).toEqual(expect.any(Number));
    expect(row.meta).not.toContain("private upstream message");
    expect(row.meta).not.toContain("private prompt text");
    expect(row.tokens).not.toContain("private prompt text");
  });

  it("keeps a terminal success when the client closes immediately after it", async () => {
    const [{ adapter, saveFailureUsage, saveUsageStats }, { createSSEStream }, { FORMATS }] = await Promise.all([
      getUsageModules(),
      import("../../open-sse/utils/stream.js"),
      import("../../open-sse/translator/formats.js"),
    ]);
    const clientRawRequest = {
      reqId: "terminal-then-close",
      usageStartedAt: performance.now() - 10,
      usageState: { responseCommitted: true, failureRecorded: false },
      usageTarget: { provider: "openai", model: "gpt-4o" },
      body: { stream: true },
      headers: {},
    };
    let successWrite;
    const stream = createSSEStream({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      onStreamComplete: () => {
        successWrite = saveUsageStats({
          provider: "openai",
          model: "gpt-test",
          tokens: { prompt_tokens: 2, completion_tokens: 1 },
          clientRawRequest,
          silent: true,
        });
      },
    });
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const readUntilTerminal = (async () => {
      await reader.read();
    })();

    await writer.write(new TextEncoder().encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n'
    ));
    await readUntilTerminal;
    await reader.cancel(); // The client closes as soon as it sees the terminal event.
    await saveFailureUsage({
      provider: "openai",
      model: "gpt-test",
      apiKey: "valid-test-key",
      clientRawRequest,
      statusCode: 499,
      aborted: true,
      stream: true,
    });
    await successWrite;

    const rows = adapter.all(`SELECT status, meta FROM usageHistory WHERE json_extract(meta, '$.reqId') = ?`, [clientRawRequest.reqId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(JSON.parse(rows[0].meta).status).toBe("ok");
  });

  it("keeps fusion physical rows separate from the logical outcome", async () => {
    const { adapter, saveFailureUsage, saveUsageStats } = await getUsageModules();
    const successful = {
      reqId: "fusion-success",
      usageState: { responseCommitted: true, failureRecorded: false, successRecorded: false },
      headers: {},
    };
    for (let i = 0; i < 2; i++) {
      await saveUsageStats({
        provider: "openai",
        model: "gpt-4o",
        tokens: { prompt_tokens: 4, completion_tokens: 2 },
        clientRawRequest: { ...successful, isFusionPanel: true, usageTarget: { provider: "openai", model: "gpt-4o" } },
        silent: true,
      });
    }
    await saveUsageStats({
      provider: "openai",
      model: "gpt-4o",
      tokens: { prompt_tokens: 8, completion_tokens: 3 },
      clientRawRequest: { ...successful, usageTarget: { provider: "openai", model: "gpt-4o" } },
      silent: true,
    });
    await saveFailureUsage({
      provider: "openai",
      model: "judge",
      clientRawRequest: successful,
      statusCode: 499,
      aborted: true,
    });

    const successfulRows = adapter.all(
      `SELECT status FROM usageHistory WHERE json_extract(meta, '$.reqId') = ?`,
      [successful.reqId]
    );
    expect(successfulRows).toHaveLength(3);
    expect(successfulRows.every((row) => row.status === "ok")).toBe(true);

    const failed = {
      reqId: "fusion-judge-failed",
      usageState: { responseCommitted: true, failureRecorded: false, successRecorded: false },
      headers: {},
    };
    for (let i = 0; i < 2; i++) {
      await saveUsageStats({
        provider: "openai",
        model: "gpt-4o",
        tokens: { prompt_tokens: 4, completion_tokens: 2 },
        clientRawRequest: { ...failed, isFusionPanel: true, usageTarget: { provider: "openai", model: "gpt-4o" } },
        silent: true,
      });
    }
    await saveFailureUsage({ provider: "openai", model: "judge", clientRawRequest: failed, statusCode: 503 });
    await saveFailureUsage({ provider: "openai", model: "judge", clientRawRequest: failed, statusCode: 504 });

    const failedRows = adapter.all(
      `SELECT status FROM usageHistory WHERE json_extract(meta, '$.reqId') = ?`,
      [failed.reqId]
    );
    expect(failedRows).toHaveLength(3);
    expect(failedRows.filter((row) => row.status === "ok")).toHaveLength(2);
    expect(failedRows.filter((row) => row.status !== "ok")).toHaveLength(1);

    const panelFailed = {
      reqId: "fusion-panel-failed",
      usageState: { responseCommitted: true, failureRecorded: false, successRecorded: false },
      headers: {},
    };
    await saveFailureUsage({
      provider: "openai",
      model: "panel",
      clientRawRequest: { ...panelFailed, isFusionPanel: true },
      statusCode: 503,
    });
    await saveFailureUsage({ provider: "openai", model: "judge", clientRawRequest: panelFailed, statusCode: 503 });
    const panelFailureRows = adapter.all(
      `SELECT status FROM usageHistory WHERE json_extract(meta, '$.reqId') = ?`,
      [panelFailed.reqId]
    );
    expect(panelFailureRows).toHaveLength(1);
    expect(panelFailureRows[0].status).toBe("503");
  });

  it("writes the denormalized session column from meta.session", async () => {
    const { adapter, saveRequestUsage } = await getUsageModules();
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-test",
      tokens: { prompt_tokens: 2, completion_tokens: 1 },
      timestamp: "2026-11-09T00:00:00.000Z",
      meta: { session: "abcdef123456" },
    });

    const row = adapter.get(`SELECT session, meta FROM usageHistory LIMIT 1`);
    expect(row.session).toBe("abcdef123456");
    expect(JSON.parse(row.meta).session).toBe(row.session);
  });

  it("applies the session migration repeatedly without backfilling rows", async () => {
    const nativeDb = new DatabaseSync(":memory:");
    nativeDb.exec(`CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, meta TEXT)`);
    nativeDb.exec(`INSERT INTO usageHistory(timestamp, meta) VALUES ('2026-11-08T00:00:00.000Z', '{"session":"old-session"}')`);
    const adapter = {
      exec: (sql) => nativeDb.exec(sql),
      all: (sql) => nativeDb.prepare(sql).all(),
    };
    const { default: migration } = await import("@/lib/db/migrations/002-usage-history-session.js");

    migration.up(adapter);
    migration.up(adapter);

    expect(adapter.all(`PRAGMA table_info(usageHistory)`).map((column) => column.name)).toContain("session");
    expect(adapter.all(`PRAGMA index_list(usageHistory)`).map((index) => index.name)).toContain("idx_uh_session");
    expect(nativeDb.prepare(`SELECT session FROM usageHistory LIMIT 1`).get().session).toBeNull();
    nativeDb.close();
  });
});
