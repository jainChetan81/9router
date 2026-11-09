import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  observe: vi.fn(), core: vi.fn(), creds: vi.fn(), combos: vi.fn(), model: vi.fn(),
  recordRouting: vi.fn(), mode: "observe",
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/piiGuard/observe.js", () => ({ observeRequest: mocks.observe, blockMessage: () => "blocked" }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ piiGuard: { mode: mocks.mode } }) }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.creds, markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: vi.fn(), completeOpenCodeGoQuotaProbe: vi.fn(), extractApiKey: () => null, isValidApiKey: vi.fn(),
}));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: mocks.model, getComboModels: mocks.combos }));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null, enforceKeyAccess: async () => null, filterAdapterModels: async (_, models) => models,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("open-sse/services/combo.js", () => ({
  detectRequiredCapabilities: () => new Set(), handleFusionChat: vi.fn(),
  handleComboChat: async ({ body, models, handleSingleModel }) => {
    let response;
    for (const model of models) {
      response = await handleSingleModel(structuredClone(body), model);
      if (response.ok) break;
    }
    return response;
  },
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: models => models, withCapacityAdapterStripping: fn => fn, getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: async (_, credentials) => credentials }));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("../../src/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: vi.fn() }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

import { handleChat } from "../../src/sse/handlers/chat.js";
const request = (model = "openai/mini") => new Request("http://localhost/v1/chat/completions", {
  method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
});

describe("PII guard chat hook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mode = "observe";
    process.env.PII_GUARD_MODULE = "/scanner.js";
    mocks.observe.mockResolvedValue({ recordRouting: mocks.recordRouting });
    mocks.combos.mockResolvedValue(null);
    mocks.model.mockImplementation(async model => { const [provider, name] = model.split("/"); return { provider, model: name }; });
    mocks.creds.mockResolvedValue({ connectionId: "c1", connectionName: "work" });
    mocks.core.mockResolvedValue({ success: true, response: Response.json({ ok: true }) });
  });
  afterEach(() => { delete process.env.PII_GUARD_MODULE; });

  it.each(["module disabled", "mode off", "initialization failed"])("serves chat with %s", async mode => {
    if (mode === "module disabled") delete process.env.PII_GUARD_MODULE;
    if (mode === "mode off") mocks.mode = "off";
    mocks.observe.mockResolvedValue(undefined);
    expect((await handleChat(request())).status).toBe(200);
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.recordRouting).not.toHaveBeenCalled();
    expect(mocks.combos).toHaveBeenCalledTimes(mode === "initialization failed" ? 2 : 1);
  });

  it("awaits the scan and records routing only after upstream resolves", async () => {
    let releaseScan, releaseCore;
    mocks.observe.mockImplementation(() => new Promise(resolve => { releaseScan = resolve; }));
    mocks.core.mockImplementation(() => new Promise(resolve => { releaseCore = resolve; }));
    const response = handleChat(request());
    await vi.waitFor(() => expect(releaseScan).toEqual(expect.any(Function)));
    expect(mocks.core).not.toHaveBeenCalled();
    releaseScan({ recordRouting: mocks.recordRouting });
    await vi.waitFor(() => expect(releaseCore).toEqual(expect.any(Function)));
    expect(mocks.recordRouting).not.toHaveBeenCalled();
    releaseCore({ success: true, response: Response.json({ ok: true }) });
    expect((await response).status).toBe(200);
    expect(mocks.recordRouting).toHaveBeenCalledWith({ provider: "openai", resolvedModel: "openai/mini", account: "work" });
  });

  it("blocks without calling upstream", async () => {
    mocks.observe.mockResolvedValue({ blocked: ["email"] });
    expect((await handleChat(request())).status).toBe(400);
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it.each([true, false])("records the last combo attempt, success=%s", async success => {
    mocks.combos.mockImplementation(async name => name === "daily" ? ["first/a", "last/b"] : null);
    mocks.core.mockImplementation(async ({ modelInfo }) => ({
      success: success && modelInfo.provider === "last",
      status: 502, error: "failed", response: Response.json({}, { status: success && modelInfo.provider === "last" ? 200 : 502 }),
    }));
    expect((await handleChat(request("daily"))).status).toBe(success ? 200 : 502);
    expect(mocks.observe.mock.calls[0][1].combo).toBe("daily");
    expect(mocks.recordRouting).toHaveBeenLastCalledWith({ provider: "last", resolvedModel: "last/b", account: "work", combo: "daily" });
  });

  it("clears a previous account when the last combo member has no credentials", async () => {
    mocks.combos.mockImplementation(async name => name === "daily" ? ["first/a", "last/b"] : null);
    mocks.creds.mockImplementation(async provider => provider === "first" ? { connectionId: "c1", connectionName: "work" } : null);
    mocks.core.mockResolvedValue({ success: false, status: 502, error: "failed", response: Response.json({}, { status: 502 }) });
    expect((await handleChat(request("daily"))).status).toBe(404);
    expect(mocks.recordRouting).toHaveBeenLastCalledWith({ provider: "last", resolvedModel: "last/b", account: null, combo: "daily" });
  });
});
