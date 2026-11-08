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

describe("Antigravity fixed-tier effort attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async ({ body }) => ({
      response: new Response(JSON.stringify({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://antigravity.test",
      headers: {},
      transformedBody: body,
      responseFormat: "claude",
    }));
  });

  it("records the preset level even when Claude requests another effort", async () => {
    const body = {
      model: "gemini-3.8-flash-high",
      stream: false,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hello" }],
    };

    const result = await handleChatCore({
      body,
      modelInfo: { provider: "antigravity", model: "gemini-3.8-flash-high" },
      credentials: { accessToken: "test-token", providerSpecificData: { projectId: "test-project" } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "antigravity-effort-test",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body,
        headers: { accept: "application/json", "user-agent": "claude-cli/test" },
      },
    });

    expect(result.success).toBe(true);
    const sentBody = executeMock.mock.calls[0][0].body;
    expect(sentBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(saveRequestUsageMock.mock.calls[0][0].meta).toMatchObject({
      clientEffort: "medium",
      sentEffort: "high",
      effortSource: "suffix",
    });
  });

  it("sends a single-level model's fixed effort over client effort", async () => {
    const body = {
      model: "hy4-preview",
      stream: false,
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hello" }],
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "codebuddy-cn", model: "hy4-preview" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "codebuddy-fixed-effort-test",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
      sourceFormatOverride: "openai",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: { accept: "application/json", "user-agent": "model-effort-test" },
      },
    });

    expect(executeMock.mock.calls.at(-1)[0].body.reasoning_effort).toBe("high");
  });
});
