import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observeRequest: vi.fn(), imageCore: vi.fn() }));
vi.mock("@/lib/piiGuard/observe.js", () => ({ observeRequest: mocks.observeRequest, blockMessage: (names) => `pii-guard blocked a new value: ${names.join(", ")}.` }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false, piiGuard: { mode: "redact" } }) }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: mocks.creds = vi.fn(), markAccountUnavailable: mocks.unavail = vi.fn(), clearAccountError: vi.fn(), extractApiKey: () => null, isValidApiKey: vi.fn() }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: mocks.modelInfo = vi.fn(), getComboModels: mocks.combos = vi.fn() }));
vi.mock("../../src/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null, enforceKeyAccess: async () => null }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.imageCore }));
vi.mock("open-sse/handlers/imageProviders/index.js", () => ({ getImageAdapter: () => null }));
vi.mock("open-sse/utils/error.js", () => ({ errorResponse: (status, message) => Response.json({ error: message }, { status }), unavailableResponse: (status, message) => Response.json({ error: message }, { status }) }));
vi.mock("open-sse/config/runtimeConfig.js", () => ({ HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, SERVICE_UNAVAILABLE: 503, FORBIDDEN: 403, BAD_GATEWAY: 502 } }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: async (p, c) => c }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.comboChat = vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), request: vi.fn(), maskKey: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";
const req = (body) => new Request("http://localhost/v1/images/generations", { method: "POST", body: JSON.stringify(body) });

describe("PII guard image-generation hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PII_GUARD_MODULE = "/scanner.js";
    mocks.imageCore.mockResolvedValue({ success: true, response: Response.json({ ok: true }) });
    mocks.combos.mockReturnValue(null); // every non-combo model unless a test says otherwise
    mocks.modelInfo.mockResolvedValue({ provider: "gpt-6", model: "mini" });
    mocks.creds.mockResolvedValue({ connectionId: "conn-1", connectionName: "Plan Pro", apiKey: "k" });
    mocks.unavail.mockResolvedValue({ shouldFallback: false });
    delete process.env.X_TEST;
  });

  it("blocks before any provider call", async () => {
    mocks.observeRequest.mockResolvedValue({ blocked: ["email"] });
    const res = await handleImageGeneration(req({ model: "g/d", prompt: "p" }));
    expect(res.status).toBe(400);
    expect(mocks.imageCore).not.toHaveBeenCalled();
  });

  // Finding 2: a null routing object must not crash combo resolution.
  it("combo with the guard disabled and no routing object still dispatches", async () => {
    delete process.env.PII_GUARD_MODULE;
    mocks.combos.mockReturnValue(["a/m1", "a/m2"]);
    await handleImageGeneration(req({ model: "daily", prompt: "p" }));
    expect(mocks.comboChat).toHaveBeenCalledTimes(1);
    expect(mocks.modelInfo).not.toHaveBeenCalled();
    expect(mocks.comboChat.mock.calls[0][0].models).toEqual(["a/m1", "a/m2"]);
    mocks.observeRequest.mockReset();
  });

  // Finding 2: routing.combo set without the pre-fix optional chaining would throw here.
  it("combo with the guard on records routing and dispatches", async () => {
    mocks.combos.mockReturnValue(["a/m1"]);
    await handleImageGeneration(req({ model: "daily", prompt: "p" }));
    expect(mocks.comboChat).toHaveBeenCalledTimes(1);
  });

  it("a single model passes the guard's recordRouting through and drives it with the account", async () => {
    const calls = [];
    mocks.observeRequest.mockImplementation(async () => ({ recordRouting: (r) => calls.push(r) }));
    await handleImageGeneration(req({ model: "gpt-6/mini", prompt: "p" }));
    expect(mocks.imageCore).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ provider: "gpt-6", resolvedModel: "gpt-6/mini", account: "Plan Pro" }]);
  });

  it("passes through a core failure to the error response", async () => {
    mocks.imageCore.mockResolvedValue({ success: false, status: 403, error: "nope", response: Response.json({ error: "nope" }, { status: 403 }) });
    const res = await handleImageGeneration(req({ model: "gpt-6/mini", prompt: "p" }));
    expect(res.status).toBe(403);
  });
});


it.each([true, false])("records the final combo member, success=%s", async success => {
  process.env.PII_GUARD_MODULE = "/scanner.js";
  const recordRouting = vi.fn();
  mocks.observeRequest.mockResolvedValue({ recordRouting });
  mocks.combos.mockResolvedValue(["first/a", "last/b"]);
  mocks.modelInfo.mockImplementation(async model => { const [provider, name] = model.split("/"); return { provider, model: name }; });
  mocks.comboChat.mockImplementation(async ({ body, models, handleSingleModel }) => {
    let response;
    for (const model of models) {
      response = await handleSingleModel(body, model);
      if (response.ok) break;
    }
    return response;
  });
  mocks.imageCore.mockImplementation(async ({ modelInfo }) => ({
    success: success && modelInfo.provider === "last", status: 502, error: "failed",
    response: Response.json({}, { status: success && modelInfo.provider === "last" ? 200 : 502 }),
  }));
  mocks.creds.mockResolvedValue({ connectionId: "c1", connectionName: "work" });
  mocks.unavail.mockResolvedValue({ shouldFallback: false });
  expect((await handleImageGeneration(req({ model: "daily", prompt: "ordinary image" }))).status).toBe(success ? 200 : 502);
  expect(mocks.observeRequest.mock.lastCall[1].combo).toBe("daily");
  expect(recordRouting).toHaveBeenLastCalledWith({ provider: "last", resolvedModel: "last/b", account: "work", combo: "daily" });
});
