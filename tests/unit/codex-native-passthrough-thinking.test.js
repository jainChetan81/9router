import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const { executeMock, forcedSSEToJsonMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  forcedSSEToJsonMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
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
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: forcedSSEToJsonMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

async function runNativeCodexRequest(model, reasoning, modelOverrides = {}, providerThinking = null, extraBody = {}) {
  const body = {
    model,
    input: "hello",
    stream: false,
    ...extraBody,
    ...(reasoning ? { reasoning } : {}),
  };

  await handleChatCore({
    body,
    modelInfo: { provider: "codex", model },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: "openai-responses",
    modelOverrides,
    providerThinking,
    clientRawRequest: {
      endpoint: "/v1/responses",
      body,
      headers: {
        accept: "application/json",
        "user-agent": "codex-cli/0.144.1",
      },
    },
  });

  return executeMock.mock.calls.at(-1)[0].body;
}

async function runNativeClaudeRequest(model, outputConfig, modelOverrides = {}, providerThinking = null) {
  const body = {
    model,
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    ...(outputConfig ? { output_config: outputConfig } : {}),
  };

  await handleChatCore({
    body,
    modelInfo: { provider: "claude", model },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: "claude",
    modelOverrides,
    providerThinking,
    clientRawRequest: {
      endpoint: "/v1/messages",
      body,
      headers: {
        accept: "application/json",
        "user-agent": "claude-cli/2.1.0",
      },
    },
  });

  return executeMock.mock.calls.at(-1)[0].body;
}

async function runNativeGeminiCliRequest(model, bodyFields = {}, modelOverrides = {}) {
  const body = {
    model,
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    stream: false,
    ...bodyFields,
  };

  await handleChatCore({
    body,
    modelInfo: { provider: "gemini-cli", model },
    credentials: { accessToken: "test-token", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: "gemini-cli",
    modelOverrides,
    clientRawRequest: {
      endpoint: "/v1internal:generateContent",
      body,
      headers: {
        accept: "application/json",
        "user-agent": "gemini-cli/0.34.0",
      },
    },
  });

  return executeMock.mock.calls.at(-1)[0].body;
}

describe("native Codex passthrough thinking suffixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response("", { status: 200 }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: null,
    });
    forcedSSEToJsonMock.mockResolvedValue({
      success: true,
      response: new Response("{}", { status: 200 }),
    });
  });

  it("forwards Ultra for Sol", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-sol(ultra)");

    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning).toEqual({ effort: "ultra" });
  });

  it("forwards Claude output_config effort through the real Codex transform", async () => {
    const body = await runNativeCodexRequest(
      "gpt-6-luna",
      null,
      { "codex/gpt-6-luna": { effort: "medium" } },
      null,
      { output_config: { effort: "high" } },
    );

    const transformed = new CodexExecutor().transformRequest(
      "gpt-6-luna",
      body,
      false,
      { connectionId: "test-connection", providerSpecificData: {} },
    );

    expect(transformed.reasoning.effort).toBe("high");
  });

  it("converts unsupported Luna Ultra to Max without dropping reasoning metadata", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-luna(ultra)", {
      effort: "low",
      summary: "detailed",
    });

    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "max", summary: "detailed" });
  });

  it("applies the saved model effort to a native passthrough request", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna(high)", { effort: "low" }, {
      "codex/gpt-6-luna": { effort: "medium", locked: true },
    });

    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning.effort).toBe("medium");
  });

  it("uses an unlocked saved effort when the client has no effort intent", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna", null, {
      "codex/gpt-6-luna": { effort: "medium" },
    });

    expect(body.reasoning.effort).toBe("medium");
  });

  it("preserves client effort over an unlocked saved effort", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna", { effort: "low" }, {
      "codex/gpt-6-luna": { effort: "medium" },
    });

    expect(body.reasoning.effort).toBe("low");
  });

  it("converts Gemini CLI reasoning_effort to native thinkingConfig over an unlocked saved default", async () => {
    const body = await runNativeGeminiCliRequest("gemini-2.5-flash", {
      reasoning_effort: "high",
    }, {
      "gemini-cli/gemini-2.5-flash": { effort: "medium" },
    });

    expect(body.reasoning_effort).toBeUndefined();
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 24576,
      includeThoughts: true,
    });
  });

  it("clamps native Gemini thinkingBudget zero when the model cannot disable thinking", async () => {
    const body = await runNativeGeminiCliRequest("gemini-3.1-pro-preview", {
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });

    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "minimal",
      includeThoughts: false,
    });
  });

  it("leaves a valid native Gemini budget untouched without a winning override", async () => {
    const nativeThinkingConfig = { thinkingBudget: 8192, includeThoughts: false };
    const body = await runNativeGeminiCliRequest("gemini-2.5-flash", {
      generationConfig: { thinkingConfig: nativeThinkingConfig },
    }, {
      "gemini-cli/gemini-2.5-flash": { effort: "medium" },
    });

    expect(body.generationConfig.thinkingConfig).toEqual(nativeThinkingConfig);
    expect(body.generationConfig).toEqual({ thinkingConfig: nativeThinkingConfig });
  });

  it("preserves a Codex hyphen suffix over an unlocked saved effort", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna-max", null, {
      "codex/gpt-6-luna": { effort: "low" },
    });

    expect(body.reasoning.effort).toBe("max");
  });

  it("lets a Codex hyphen suffix override client effort on native passthrough", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna-max", { effort: "low" });

    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning.effort).toBe("max");
  });

  it("does not let a provider default override a Codex hyphen suffix", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna-max", null, {}, { mode: "low" });

    expect(body.reasoning.effort).toBe("max");
  });

  it("lets a saved effort override a Codex hyphen suffix", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna-max", null, {
      "codex/gpt-6-luna": { effort: "high", locked: true },
    });

    expect(body.reasoning.effort).toBe("high");
  });

  it("attributes a Codex hyphen suffix as the effort source", async () => {
    await runNativeCodexRequest("gpt-6-luna-max");

    expect(forcedSSEToJsonMock.mock.calls.at(-1)[0].clientRawRequest.effort).toEqual({
      clientEffort: null,
      sentEffort: "max",
      effortSource: "suffix",
    });
  });

  it.each([
    ["reasoning.effort", { reasoning: { effort: "low" } }],
    ["reasoning_effort", { reasoning_effort: "low" }],
    ["Claude output_config.effort", { output_config: { effort: "low" } }],
    ["Claude thinking", { thinking: { type: "enabled", budget_tokens: 4096 } }],
    ["Gemini thinkingLevel", { thinkingConfig: { thinkingLevel: "low" } }],
  ])("does not override client %s with provider defaults", async (_shape, fields) => {
    const body = await runNativeCodexRequest("gpt-6-luna", null, {}, { mode: "high" }, fields);

    const transformed = new CodexExecutor().transformRequest("gpt-6-luna", body, false, {});

    expect(transformed.reasoning.effort).toBe("low");
  });

  it("applies provider defaults when the client has no effort intent", async () => {
    const body = await runNativeCodexRequest("gpt-6-luna", null, {}, { mode: "high" });

    expect(body.reasoning.effort).toBe("high");
  });

  it("applies a saved effort to native Claude passthrough requests", async () => {
    const body = await runNativeClaudeRequest("claude-sonnet-5.5(high)", { effort: "high" }, {
      "claude/claude-sonnet-5.5": { effort: "low", locked: true },
    });

    expect(body.model).toBe("claude-sonnet-5.5");
    expect(body.output_config.effort).toBe("low");
  });

  it("preserves unrelated Claude output config when disabling effort", async () => {
    const format = { type: "json_schema", schema: { type: "object" } };
    const body = await runNativeClaudeRequest("claude-sonnet-5.5", { effort: "high", format }, {
      "claude/claude-sonnet-5.5": { effort: "none", locked: true },
    });

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({ format });
  });

  it("lets a Claude model suffix override the client's effort in passthrough", async () => {
    const body = await runNativeClaudeRequest("claude-sonnet-5.5(high)", { effort: "low" });

    expect(body.model).toBe("claude-sonnet-5.5");
    expect(body.output_config.effort).toBe("high");
  });

  it("normalizes provider defaults for native Claude passthrough", async () => {
    const body = await runNativeClaudeRequest("claude-sonnet-5.5", null, {}, { mode: "low" });

    expect(body.output_config.effort).toBe("low");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("forwards Ultra through a Terra review alias", async () => {
    const body = await runNativeCodexRequest("gpt-5.6-terra-review(ultra)", {
      effort: "low",
    });

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning).toEqual({ effort: "ultra" });
  });
});
