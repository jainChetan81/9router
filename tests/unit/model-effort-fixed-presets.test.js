import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, saveRequestUsageMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveRequestUsageMock: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: saveRequestUsageMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { GrokCliExecutor } = await import("../../open-sse/executors/grok-cli.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

async function sendRequest({ provider, model, body, modelOverrides }) {
  executeMock.mockImplementation(async ({ body: sentBody }) => ({
    response: new Response(JSON.stringify({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    url: `https://${provider}.test`,
    headers: {},
    transformedBody: sentBody,
    responseFormat: "claude",
  }));

  const result = await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { accessToken: "test-token", connectionId: `${provider}-effort-test`, providerSpecificData: {} },
    log,
    connectionId: `${provider}-effort-test`,
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: "openai",
    modelOverrides,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json", "user-agent": "model-effort-test" },
    },
  });
  if (result.response?.body) await result.response.arrayBuffer();

  return { result, sentBody: executeMock.mock.calls.at(-1)[0].body, usage: saveRequestUsageMock.mock.calls.at(-1)?.[0] };
}

describe("bare-upstream fixed-effort presets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins Grok CLI low when the client requests high", async () => {
    const body = {
      model: "grok-4.5-low",
      stream: false,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hello" }],
    };

    const { result, sentBody } = await sendRequest({ provider: "grok-cli", model: "grok-4.5-low", body });
    const wireBody = new GrokCliExecutor().transformRequest(
      "grok-4.5-low",
      structuredClone(sentBody),
      true,
      { connectionId: "grok-fixed-effort-test", rawHeaders: {} },
    );

    expect(result.success).toBe(true);
    expect(sentBody.reasoning_effort).toBe("low");
    expect(wireBody.reasoning.effort).toBe("low");
  });

  it.each(["low", "medium", "high"])("sends Grok CLI %s when no effort is requested", async (effort) => {
    const model = `grok-4.5-${effort}`;
    const body = {
      model,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
    const { result, sentBody } = await sendRequest({ provider: "grok-cli", model, body });
    const wireBody = new GrokCliExecutor().transformRequest(
      model,
      structuredClone(sentBody),
      true,
      { connectionId: `grok-no-intent-${effort}`, rawHeaders: {} },
    );

    expect(result.success).toBe(true);
    expect(wireBody.model).toBe("grok-4.5");
    expect(wireBody.reasoning.effort).toBe(effort);
  });

  it("disables DeepSeek V4 Pro thinking when the client requests high", async () => {
    const body = {
      model: "deepseek-v4-pro-none",
      stream: false,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hello" }],
    };

    const { result, sentBody, usage } = await sendRequest({ provider: "deepseek", model: "deepseek-v4-pro-none", body });

    expect(result.success).toBe(true);
    expect(sentBody.model).toBe("deepseek-v4-pro");
    expect(sentBody.thinking).toEqual({ type: "disabled" });
    expect(usage.meta).toMatchObject({ clientEffort: "high", sentEffort: "none", effortSource: "suffix" });
  });

  it("pins Antigravity Gemini 3.1 Pro high when the client requests low", async () => {
    const body = {
      model: "gemini-3.1-pro-high",
      stream: false,
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hello" }],
    };

    const { result, sentBody, usage } = await sendRequest({
      provider: "antigravity",
      model: "gemini-3.1-pro-high",
      body,
    });

    expect(result.success).toBe(true);
    expect(sentBody.model).toBe("gemini-pro-agent");
    expect(sentBody.request.generationConfig?.thinkingConfig).toBeUndefined();
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(usage.meta).toMatchObject({ clientEffort: "low", sentEffort: "high", effortSource: "suffix" });
  });

  it.each([
    ["antigravity", "gpt-oss-120b-medium", "medium"],
  ])("attributes %s/%s from its fixed model tier", async (provider, model, effort) => {
    const body = {
      model,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
    const { result, sentBody, usage } = await sendRequest({ provider, model, body });

    expect(result.success).toBe(true);
    expect(sentBody.model).toBe(model);
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.thinking).toBeUndefined();
    expect(sentBody.output_config).toBeUndefined();
    expect(sentBody.request?.generationConfig?.thinkingConfig).toBeUndefined();
    expect(usage.meta).toMatchObject({ sentEffort: effort, effortSource: "suffix" });
  });

  it("drops client effort fields when a fixed tier is selected by the model ID", async () => {
    const model = "gpt-oss-120b-medium";
    const body = {
      model,
      stream: false,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hello" }],
    };
    const { sentBody, usage } = await sendRequest({ provider: "antigravity", model, body });

    expect(sentBody.model).toBe(model);
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.request?.generationConfig?.thinkingConfig).toBeUndefined();
    expect(usage.meta).toMatchObject({ clientEffort: "high", sentEffort: "medium", effortSource: "suffix" });
  });

  it("keeps a stale saved setting from overriding a fixed no-thinking preset", async () => {
    const body = {
      model: "deepseek-v4-pro-none",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };

    const { result, sentBody, usage } = await sendRequest({
      provider: "deepseek",
      model: "deepseek-v4-pro-none",
      body,
      modelOverrides: { "deepseek/deepseek-v4-pro-none": { effort: "high" } },
    });

    expect(result.success).toBe(true);
    expect(sentBody.thinking).toEqual({ type: "disabled" });
    expect(usage.meta).toMatchObject({ sentEffort: "none", effortSource: "suffix" });
  });

  it("sends fixed DeepSeek effort and keeps Antigravity's selected-model payload", async () => {
    const deepseekBody = {
      model: "deepseek-v4-pro-none",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
    const deepseek = await sendRequest({ provider: "deepseek", model: "deepseek-v4-pro-none", body: deepseekBody });

    expect(deepseek.result.success).toBe(true);
    expect(deepseek.sentBody.model).toBe("deepseek-v4-pro");
    expect(deepseek.sentBody.thinking).toEqual({ type: "disabled" });
    expect(deepseek.usage.meta).toMatchObject({ sentEffort: "none", effortSource: "suffix" });

    const antigravityBody = {
      model: "gemini-3.1-pro-high",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
    const antigravity = await sendRequest({
      provider: "antigravity",
      model: "gemini-3.1-pro-high",
      body: antigravityBody,
    });

    expect(antigravity.result.success).toBe(true);
    expect(antigravity.sentBody.model).toBe("gemini-pro-agent");
    expect(antigravity.sentBody.request.generationConfig?.thinkingConfig).toBeUndefined();
    expect(antigravity.usage.meta).toMatchObject({ sentEffort: "high", effortSource: "suffix" });
  });
});
