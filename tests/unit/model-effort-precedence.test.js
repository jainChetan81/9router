import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelEffortKey } from "../../open-sse/services/modelEffort.js";
import { resolveProviderDefaultEffort } from "../../open-sse/services/modelEffortDefaults.js";

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

async function sendRequest({
  provider = "openai-compatible-chat-test",
  model = "gpt-6-luna",
  fields = {},
  modelOverrides,
  providerThinking = null,
  sourceFormatOverride = "openai",
  requestBody = null,
} = {}) {
  const body = requestBody || {
      model,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      ...fields,
    };
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
    credentials: { accessToken: "test-token", connectionId: "effort-precedence", providerSpecificData: { apiType: "chat" } },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "effort-precedence",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride,
    modelOverrides,
    providerThinking,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json", "user-agent": "model-effort-precedence-test" },
    },
  });
  if (result.response?.body) await result.response.arrayBuffer();

  return {
    result,
    sentBody: executeMock.mock.calls.at(-1)[0].body,
    usage: saveRequestUsageMock.mock.calls.at(-1)?.[0],
  };
}

function setting(provider, model, effort, locked) {
  return { [getModelEffortKey(provider, model)]: { effort, ...(locked === undefined ? {} : { locked }) } };
}

describe("saved model effort precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets client xhigh override an unlocked saved default", async () => {
    const { sentBody, usage } = await sendRequest({
      fields: { reasoning_effort: "xhigh" },
      modelOverrides: setting("openai-compatible-chat-test", "gpt-6-luna", "medium"),
    });

    expect(sentBody.reasoning_effort).toBe("xhigh");
    expect(usage.meta).toMatchObject({ clientEffort: "xhigh", sentEffort: "xhigh", effortSource: "client" });
  });

  it("uses an unlocked saved default when there is no client intent", async () => {
    const { sentBody, usage } = await sendRequest({
      modelOverrides: setting("openai-compatible-chat-test", "gpt-6-luna", "medium"),
      providerThinking: { mode: "high" },
    });

    expect(sentBody.reasoning_effort).toBe("medium");
    expect(usage.meta).toMatchObject({ clientEffort: null, sentEffort: "medium", effortSource: "model-default" });
  });

  it("lets a locked setting override client effort", async () => {
    const { sentBody, usage } = await sendRequest({
      fields: { reasoning_effort: "xhigh" },
      modelOverrides: setting("openai-compatible-chat-test", "gpt-6-luna", "low", true),
    });

    expect(sentBody.reasoning_effort).toBe("low");
    expect(usage.meta).toMatchObject({ clientEffort: "xhigh", sentEffort: "low", effortSource: "model-lock" });
  });

  it("lets an explicit model suffix override an unlocked default", async () => {
    const { sentBody, usage } = await sendRequest({
      model: "gpt-6-luna(high)",
      fields: { reasoning_effort: "low" },
      modelOverrides: setting("openai-compatible-chat-test", "gpt-6-luna", "medium"),
    });

    expect(sentBody.reasoning_effort).toBe("high");
    expect(usage.meta).toMatchObject({ clientEffort: "low", sentEffort: "high", effortSource: "suffix" });
  });

  it("uses a saved default instead of an implicit registry tier", async () => {
    const provider = "antigravity";
    const model = "gemini-3.8-flash";
    const { usage } = await sendRequest({
      provider,
      model,
      modelOverrides: setting(provider, model, "high"),
    });

    expect(usage.meta).toMatchObject({ sentEffort: "high", effortSource: "model-default" });
  });

  it.each([
    ["Gemini high", "antigravity", {
      model: "gemini-3.8-flash",
      userAgent: "antigravity",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
      },
      stream: false,
    }, "antigravity", "high", "gemini-3.8-flash-high"],
    ["Gemini 4096 budget", "antigravity", {
      model: "gemini-3.8-flash",
      userAgent: "antigravity",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 4096 } },
      },
      stream: false,
    }, "antigravity", "low", "gemini-3.8-flash-low"],
    ["adaptive Claude thinking", "antigravity", {
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive" },
      stream: false,
    }, "claude", "high", "gemini-3.8-flash-high"],
    ["disabled Claude thinking (Gemini 3.8 low floor)", "antigravity", {
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
      stream: false,
    }, "claude", "low", "gemini-3.8-flash-low"],
  ])("honors %s over an implicit Antigravity registry tier", async (_name, provider, body, sourceFormatOverride, expectedLevel, expectedModel) => {
    const { sentBody } = await sendRequest({ provider, model: body.model, requestBody: body, sourceFormatOverride });

    expect(sentBody.model).toBe(expectedModel);
    expect(sentBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe(expectedLevel);
  });

  it("lets the provider default override an implicit registry tier", async () => {
    const model = "gemini-3.8-flash";
    const { sentBody, usage } = await sendRequest({
      provider: "antigravity",
      model,
      requestBody: {
        model,
        userAgent: "antigravity",
        request: { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: {} },
        stream: false,
      },
      sourceFormatOverride: "antigravity",
      providerThinking: { mode: "high" },
    });

    expect(sentBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(sentBody.model).toBe("gemini-3.8-flash-high");
    expect(usage.meta).toMatchObject({ sentEffort: "high", effortSource: "provider-default" });
    expect(resolveProviderDefaultEffort({
      provider: "antigravity",
      model,
      providerThinking: { mode: "high" },
      targetFormat: "antigravity",
    })).toBe("high");
  });

  it("attributes a client-derived routed suffix to the client", async () => {
    const { usage } = await sendRequest({
      provider: "antigravity",
      model: "gemini-3.8-flash",
      fields: { reasoning_effort: "low" },
    });

    expect(usage.meta).toMatchObject({ clientEffort: "low", sentEffort: "low", effortSource: "client" });
  });

  it("lets a locked setting override an explicit model suffix", async () => {
    const { sentBody, usage } = await sendRequest({
      model: "gpt-6-luna(high)",
      fields: { reasoning_effort: "medium" },
      modelOverrides: setting("openai-compatible-chat-test", "gpt-6-luna", "low", true),
    });

    expect(sentBody.reasoning_effort).toBe("low");
    expect(usage.meta).toMatchObject({ clientEffort: "medium", sentEffort: "low", effortSource: "model-lock" });
  });

  it.each([undefined, false, true])("keeps fixed tiers above saved settings (locked=%s)", async (locked) => {
    const provider = "antigravity";
    const model = "gemini-3.1-pro-high";
    const { sentBody, usage } = await sendRequest({
      provider,
      model,
      modelOverrides: setting(provider, model, "low", locked),
    });

    expect(sentBody.model).toBe("gemini-pro-agent");
    expect(usage.meta).toMatchObject({ sentEffort: "high", effortSource: "suffix" });
  });

  it.each([
    ["explicit none", { reasoning_effort: "none" }, "none"],
    ["explicit auto", { reasoning_effort: "auto" }, "auto"],
    ["adaptive thinking", { thinking: { type: "adaptive" } }, "auto"],
    ["budget thinking", { thinking: { type: "enabled", budget_tokens: 4096 } }, "low"],
  ])("keeps %s client intent above an unlocked default", async (_name, fields, sentEffort) => {
    const { sentBody, usage } = await sendRequest({
      fields,
      modelOverrides: setting("openai-compatible-chat-test", "gpt-6-luna", "medium"),
    });

    expect(sentBody.reasoning_effort).toBe(sentEffort);
    expect(usage.meta).toMatchObject({ sentEffort, effortSource: "client" });
  });

  it("keeps a saved Kiro effort in native fields for Responses clients", async () => {
    const model = "claude-sonnet-5.5";
    const { sentBody } = await sendRequest({
      provider: "kiro",
      model,
      requestBody: { model, input: "hello", stream: false },
      sourceFormatOverride: "openai-responses",
      modelOverrides: setting("kiro", model, "medium"),
    });

    expect(sentBody.additionalModelRequestFields.output_config.effort).toBe("medium");
    expect(sentBody).not.toHaveProperty("thinking");
    expect(sentBody).not.toHaveProperty("output_config");
  });
});
