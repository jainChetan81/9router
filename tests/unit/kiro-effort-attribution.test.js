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

describe("Kiro effort usage attribution", () => {
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
      url: "https://kiro.test",
      headers: {},
      transformedBody: body,
      responseFormat: "claude",
    }));
  });

  it("records the final budget from Kiro's prompt tags", async () => {
    const body = {
      model: "claude-sonnet-4.5",
      stream: false,
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "continue" },
      ],
    };

    const result = await handleChatCore({
      body,
      modelInfo: { provider: "kiro", model: "claude-sonnet-4.5" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "kiro-effort-test",
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
    expect(sentBody.thinking).toBeUndefined();
    expect(JSON.stringify(sentBody)).toContain("<max_thinking_length>10000</max_thinking_length>");
    expect(JSON.stringify(sentBody)).not.toContain("_kiroThinkingBudget");
    expect(saveRequestUsageMock.mock.calls[0][0].meta).toMatchObject({
      clientEffort: "medium",
      sentEffort: "medium",
      effortSource: "client",
    });
  });
});
