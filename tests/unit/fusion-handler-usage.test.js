import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { executeMock, credentialsMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  credentialsMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: credentialsMock,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  completeOpenCodeGoQuotaProbe: vi.fn(async () => ({ updated: false })),
  extractApiKey: () => null,
  isValidApiKey: vi.fn(async () => false),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(async () => {}),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;
let handleChat;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fusion-usage-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();

  const [{ getAdapter }, localDb] = await Promise.all([
    import("@/lib/db/driver.js"),
    import("@/lib/localDb.js"),
  ]);
  adapter = await getAdapter();
  await localDb.createCombo({
    name: "fusion-usage-test",
    models: ["openai/gpt-4o-mini", "openai/gpt-4o"],
  });
  await localDb.updateSettings({
    requireApiKey: false,
    comboStrategy: "fusion",
    comboStrategies: {
      "fusion-usage-test": {
        fallbackStrategy: "fusion",
        judgeModel: "openai/gpt-4.1",
      },
    },
  });
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
});

afterAll(() => {
  try { adapter?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("fusion usage through the chat handler", () => {
  it("keeps panel rows and records one failure when the judge fails", async () => {
    credentialsMock.mockResolvedValue({
      connectionId: "fusion-test-connection",
      connectionName: "fusion-test",
      accessToken: "test-token",
      providerSpecificData: {},
    });
    executeMock.mockImplementation(async ({ model, body }) => {
      if (model === "gpt-4.1") {
        return {
          response: new Response(JSON.stringify({ error: { message: "judge failed" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
          url: "https://mock.openai.test/v1/chat/completions",
          headers: {},
          transformedBody: body,
        };
      }
      return {
        response: new Response([
          `data: ${JSON.stringify({ id: `completion-${model}`, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: `completion-${model}`, model, choices: [{ index: 0, delta: { content: `answer-${model}` }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: `completion-${model}`, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        url: "https://mock.openai.test/v1/chat/completions",
        headers: {},
        transformedBody: body,
      };
    });

    const clientRawRequest = { endpoint: "/v1/chat/completions", headers: {} };
    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "fusion-usage-test" },
      body: JSON.stringify({
        model: "fusion-usage-test",
        stream: false,
        messages: [{ role: "user", content: "test fusion telemetry" }],
      }),
    }), clientRawRequest);
    expect(response.status).toBe(503);
    const reqId = clientRawRequest.reqId;
    const failureRows = adapter.all(
      "SELECT meta, status FROM usageHistory WHERE json_extract(meta, '$.reqId') = ? AND status <> 'ok'",
      [reqId]
    );
    expect(failureRows).toHaveLength(1);
    const meta = JSON.parse(failureRows[0].meta);
    expect(failureRows[0].status).toBe("503");
    expect(meta.reqId).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = adapter.all(
      "SELECT provider, model, status, meta FROM usageHistory WHERE json_extract(meta, '$.reqId') = ? ORDER BY id",
      [meta.reqId]
    );
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.status === "ok")).toHaveLength(2);
    expect(rows.filter((row) => row.status !== "ok")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "ok").map((row) => row.model).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  it("keeps an upstream-accepted unregistered model and calculates its configured cost", async () => {
    const { updatePricing } = await import("@/lib/localDb.js");
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    const model = "unlisted-release-model";
    const pricing = { input: 3, output: 9 };
    await updatePricing({ openai: { [model]: pricing } });
    credentialsMock.mockResolvedValue({
      connectionId: "fusion-test-connection",
      connectionName: "fusion-test",
      accessToken: "test-token",
      providerSpecificData: {},
    });
    executeMock.mockResolvedValue({
      response: new Response([
        `data: ${JSON.stringify({ id: "unlisted-model-completion", model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "unlisted-model-completion", model, choices: [{ index: 0, delta: { content: "accepted" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "unlisted-model-completion", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://mock.openai.test/v1/chat/completions",
      headers: {},
      transformedBody: {},
    });

    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "usage-target-test" },
      body: JSON.stringify({
        model: `openai/${model}`,
        stream: true,
        messages: [{ role: "user", content: "test model telemetry" }],
      }),
    }));
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = adapter.get(
      "SELECT provider, model, cost FROM usageHistory WHERE model = ? ORDER BY id DESC LIMIT 1",
      [model]
    );
    expect(row).toMatchObject({ provider: "openai", model });
    expect(row.cost).toBe(calculateCostFromTokens({ prompt_tokens: 9, completion_tokens: 5 }, pricing));
  });
});
