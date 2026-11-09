import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observeRequest: vi.fn(), embeddingsCore: vi.fn() }));
vi.mock("@/lib/piiGuard/observe.js", () => ({ observeRequest: mocks.observeRequest, blockMessage: (names) => `pii-guard blocked a new value: ${names.join(", ")}.` }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false, piiGuard: { mode: "redact" } }) }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: mocks.creds = vi.fn(), markAccountUnavailable: mocks.unavail = vi.fn(), clearAccountError: vi.fn(), extractApiKey: () => null, isValidApiKey: vi.fn() }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: mocks.modelInfo = vi.fn(async () => ({ provider: "openai", model: "text-embedding-3" })), getComboModels: vi.fn(async () => null) }));
vi.mock("../../src/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null, enforceKeyAccessResolved: async () => null }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.embeddingsCore }));
vi.mock("open-sse/utils/error.js", () => ({ errorResponse: (status, message) => Response.json({ error: message }, { status }), unavailableResponse: (status, message) => Response.json({ error: message }, { status }) }));
vi.mock("open-sse/config/runtimeConfig.js", () => ({ HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, SERVICE_UNAVAILABLE: 503, FORBIDDEN: 403, BAD_GATEWAY: 502 } }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: async (p, c) => c }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.comboChat = vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), request: vi.fn(), maskKey: vi.fn() }));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";
const req = (body) => new Request("http://localhost/v1/embeddings", { method: "POST", body: JSON.stringify(body) });

describe("PII guard embeddings hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PII_GUARD_MODULE = "/scanner.js";
    mocks.embeddingsCore.mockResolvedValue({ success: true, response: Response.json({ ok: true }) });
    mocks.creds.mockResolvedValue({ connectionId: "conn-1", connectionName: "Key A", apiKey: "k" });
    mocks.unavail.mockResolvedValue({ shouldFallback: false });
  });

  it("blocks before any provider call", async () => {
    mocks.observeRequest.mockResolvedValue({ blocked: ["email"] });
    const res = await handleEmbeddings(req({ model: "openai/text-embedding-3", input: "x" }));
    expect(res.status).toBe(400);
    expect(mocks.embeddingsCore).not.toHaveBeenCalled();
  });

  it("passes the guard's finalize through and drives it with provider and account", async () => {
    const calls = [];
    mocks.observeRequest.mockImplementation(async () => ({ finalize: (r) => calls.push(r) }));
    await handleEmbeddings(req({ model: "openai/text-embedding-3", input: "x" }));
    expect(mocks.embeddingsCore).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ provider: "openai" }, { account: "Key A" }]); // requested model already matches: no resolvedModel
  });

  it("records a resolvedModel when the provider resolves a bare model name", async () => {
    const calls = [];
    mocks.observeRequest.mockImplementation(async () => ({ finalize: (r) => calls.push(r) }));
    await handleEmbeddings(req({ model: "text-embedding-3", input: "x" }));
    expect(calls).toEqual([{ provider: "openai", resolvedModel: "openai/text-embedding-3" }, { account: "Key A" }]);
  });
});
