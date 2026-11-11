import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  settings: { requireApiKey: false, comboStrategy: "fallback", ccFilterNaming: false },
  combos: {},
  keyAccess: null,
  keyDenied: null,
}));

const mocks = vi.hoisted(() => ({
  core: vi.fn(),
  creds: vi.fn(),
  observe: vi.fn(),
  isValidApiKey: vi.fn(),
  saveFailureUsage: vi.fn(async () => true),
  resolveSmartChoice: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getCombos: async () => Object.entries(fx.combos).map(([name, models]) => ({ name, models })),
  getProviderNodes: async () => [],
  getCustomModels: async () => [],
  getComboByName: async (name) => (fx.combos[name] ? { name, models: fx.combos[name] } : null),
  getModelAliases: async () => ({}),
}));
vi.mock("@/lib/piiGuard/observe.js", () => ({
  observeRequest: mocks.observe,
  blockMessage: () => "blocked by pii guard",
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.creds,
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: vi.fn(),
  completeOpenCodeGoQuotaProbe: vi.fn(),
  extractApiKey: (req) => {
    const h = req?.headers?.get?.("authorization");
    return h?.startsWith("Bearer ") ? h.slice(7) : null;
  },
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (modelStr) => {
    if (typeof modelStr === "string" && modelStr.includes("/")) {
      const idx = modelStr.indexOf("/");
      const provider = modelStr.slice(0, idx);
      const model = modelStr.slice(idx + 1);
      if (provider && model) return { provider, model };
    }
    return { provider: null, model: modelStr };
  },
  getComboModels: async (name) => fx.combos[name] || null,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => fx.keyAccess,
  enforceKeyAccess: async () => fx.keyDenied,
  filterAdapterModels: async (_ctx, models) => models,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.core,
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  saveFailureUsage: mocks.saveFailureUsage,
  saveUsageStats: vi.fn(async () => true),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_p, credentials) => credentials,
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("../../src/sse/services/systemoneRouter.js", () => ({
  resolveSmartChoice: mocks.resolveSmartChoice,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: (k) => k, request: vi.fn(),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

import { handleChat } from "../../src/sse/handlers/chat.js";
import { snapshot, unregister } from "../../src/lib/agents/liveRegistry.js";
import { getLive } from "../../src/lib/agents/queries.js";
import { resetSessionColumnCache } from "../../src/lib/agents/dbColumns.js";

const enc = new TextEncoder();

function emptyLiveDb() {
  return {
    driver: "sql.js",
    all(sql) {
      if (sql === "PRAGMA table_info(usageHistory)") return [{ name: "session" }];
      return [];
    },
  };
}

function allLiveEntries() {
  return Object.values(snapshot()).flat();
}

function postChat(body, { headers = {}, signal } = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": "b5-test-session", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

describe("agents live lifecycle wiring (B5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.settings = { requireApiKey: false, comboStrategy: "fallback", ccFilterNaming: false };
    fx.combos = {};
    fx.keyAccess = null;
    fx.keyDenied = null;
    delete process.env.PII_GUARD_MODULE;
    mocks.creds.mockResolvedValue({ connectionId: "conn-1", connectionName: "acc-1" });
    mocks.isValidApiKey.mockResolvedValue(false);
    mocks.observe.mockResolvedValue({ recordRouting: vi.fn() });
    mocks.core.mockResolvedValue({ success: true, response: Response.json({ id: "ok" }) });
    for (const req of allLiveEntries()) unregister(req.reqId);
    resetSessionColumnCache();
  });

  afterEach(() => {
    delete process.env.PII_GUARD_MODULE;
    for (const req of allLiveEntries()) unregister(req.reqId);
    resetSessionColumnCache();
  });

  it("never registers requests rejected before provider routing", async () => {
    const snapshotsDuringCall = [];
    const originalCreds = mocks.creds;
    originalCreds.mockImplementation(async () => {
      snapshotsDuringCall.push(allLiveEntries());
      return { connectionId: "conn-1", connectionName: "acc-1" };
    });

    // 1. Invalid JSON
    expect((await handleChat(postChat("{bad-json"))).status).toBe(400);
    expect(allLiveEntries()).toHaveLength(0);

    // 2. Non-object body
    expect((await handleChat(postChat([]))).status).toBe(400);
    expect(allLiveEntries()).toHaveLength(0);

    // 3. PII Guard block
    process.env.PII_GUARD_MODULE = "/fake-scanner.js";
    mocks.observe.mockResolvedValueOnce({ blocked: ["email"] });
    expect((await handleChat(postChat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }))).status).toBe(400);
    expect(allLiveEntries()).toHaveLength(0);
    delete process.env.PII_GUARD_MODULE;

    // 4. requireApiKey 401
    fx.settings = { requireApiKey: true, comboStrategy: "fallback", ccFilterNaming: false };
    expect((await handleChat(postChat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }))).status).toBe(401);
    expect(allLiveEntries()).toHaveLength(0);
    fx.settings = { requireApiKey: false, comboStrategy: "fallback", ccFilterNaming: false };

    // 5. Missing model
    expect((await handleChat(postChat({ messages: [{ role: "user", content: "hi" }] }))).status).toBe(400);
    expect(allLiveEntries()).toHaveLength(0);

    // 6. Key access 403
    fx.keyDenied = Response.json({ error: { message: "denied" } }, { status: 403 });
    expect((await handleChat(postChat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }))).status).toBe(403);
    expect(allLiveEntries()).toHaveLength(0);
    fx.keyDenied = null;

    // 7. Bypass warmup request (claude-cli user-agent required for bypass matcher)
    const warmup = await handleChat(postChat({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "Warmup" }],
    }, { headers: { "user-agent": "claude-cli/1.0" } }));
    expect(warmup.status).toBe(200);
    expect(allLiveEntries()).toHaveLength(0);

    // 8. Invalid model format (no slash, not a combo)
    expect((await handleChat(postChat({ model: "not-a-model-or-combo", messages: [{ role: "user", content: "hi" }] }))).status).toBe(400);
    expect(allLiveEntries()).toHaveLength(0);
    expect(snapshotsDuringCall).toHaveLength(0);
  });

  it("keeps implicit SSE streams live until EOF and transitions thinking -> streaming on first semantic token", async () => {
    let streamController;
    let capturedOnFirstToken;
    mocks.core.mockImplementation(async ({ onFirstToken }) => {
      capturedOnFirstToken = onFirstToken;
      const body = new ReadableStream({
        start(controller) { streamController = controller; },
      });
      return {
        success: true,
        response: new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        }),
      };
    });

    // Omit body.stream so it exercises implicit SSE (body.stream === undefined)
    const response = await handleChat(postChat({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    }));

    expect(response.status).toBe(200);
    expect(allLiveEntries()).toHaveLength(1);
    expect(allLiveEntries()[0]).toMatchObject({ model: "openai/gpt-4o", provider: "openai", firstTokenAt: null });

    const beforeToken = await getLive(emptyLiveDb(), Date.now());
    expect(beforeToken.inFlight).toBe(1);
    expect(beforeToken.sessions[0].roles[0].state).toBe("thinking");

    const now = performance.now();
    capturedOnFirstToken(now);
    const afterToken = await getLive(emptyLiveDb(), Date.now());
    expect(afterToken.inFlight).toBe(1);
    expect(afterToken.sessions[0].roles[0].state).toBe("streaming");

    streamController.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    streamController.close();

    const reader = response.body.getReader();
    while (!(await reader.read()).done);
    expect(allLiveEntries()).toHaveLength(0);
  });

  it("unregisters non-SSE application/json responses even when body.stream is true and handles locked getReader failure", async () => {
    mocks.core.mockResolvedValueOnce({
      success: true,
      response: Response.json({ id: "img_1" }),
    });
    const jsonRes = await handleChat(postChat({
      model: "openai/gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "draw" }],
    }));
    expect(jsonRes.status).toBe(200);
    expect(allLiveEntries()).toHaveLength(0);

    // Locked Response.body causes response.body.getReader() inside wrapLiveTerminal to throw
    const lockedResMock = new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    lockedResMock.body.getReader();
    mocks.core.mockResolvedValueOnce({
      success: true,
      response: lockedResMock,
    });
    const lockedRes = await handleChat(postChat({
      model: "openai/gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(lockedRes.status).toBe(200);
    expect(allLiveEntries()).toHaveLength(0);
  });

  it("unregisters SSE streams on consumer cancel and upstream read errors while removing abort listeners", async () => {
    // 1. Consumer cancel
    const cancelReq = postChat({ model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "cancel" }] }, { signal: new AbortController().signal });
    const addCancelSpy = vi.spyOn(cancelReq.signal, "addEventListener");
    const removeCancelSpy = vi.spyOn(cancelReq.signal, "removeEventListener");
    let cancelUpstreamController;
    mocks.core.mockImplementationOnce(async () => ({
      success: true,
      response: new Response(new ReadableStream({ start(c) { cancelUpstreamController = c; } }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }));
    const cancelRes = await handleChat(cancelReq);
    expect(allLiveEntries()).toHaveLength(1);
    const cancelReader = cancelRes.body.getReader();
    await cancelReader.cancel("client stopped");
    expect(allLiveEntries()).toHaveLength(0);
    expect(addCancelSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeCancelSpy).toHaveBeenCalledWith("abort", addCancelSpy.mock.calls[0][1]);
    try { cancelUpstreamController.close(); } catch {}

    // 2. Upstream stream read error
    const errReq = postChat({ model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "err" }] }, { signal: new AbortController().signal });
    const addErrSpy = vi.spyOn(errReq.signal, "addEventListener");
    const removeErrSpy = vi.spyOn(errReq.signal, "removeEventListener");
    let errController;
    mocks.core.mockImplementationOnce(async () => ({
      success: true,
      response: new Response(new ReadableStream({ start(c) { errController = c; } }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }));
    const errRes = await handleChat(errReq);
    expect(allLiveEntries()).toHaveLength(1);
    errController.error(new Error("upstream socket reset"));
    const errReader = errRes.body.getReader();
    await expect(errReader.read()).rejects.toThrow("upstream socket reset");
    expect(allLiveEntries()).toHaveLength(0);
    expect(addErrSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeErrSpy).toHaveBeenCalledWith("abort", addErrSpy.mock.calls[0][1]);
  });

  it("unregisters on AbortSignal, ignores pre-aborted signals, blocks late re-registration, and cleans up listeners", async () => {
    // 1. Pre-aborted signal never leaves an entry even for combos
    fx.combos = { assistant: ["openai/gpt-4o"] };
    const preController = new AbortController();
    preController.abort();
    await handleChat(postChat({ model: "assistant", messages: [{ role: "user", content: "hi" }] }, { signal: preController.signal }));
    expect(allLiveEntries()).toHaveLength(0);

    // 2. Active abort mid-combo removes entry immediately and prevents candidate 2 from re-registering
    fx.combos = { assistant: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"] };
    const abortController = new AbortController();
    let seenDuringCandidate2 = null;
    mocks.core
      .mockImplementationOnce(async () => {
        expect(allLiveEntries()).toHaveLength(1);
        abortController.abort();
        expect(allLiveEntries()).toHaveLength(0);
        return {
          success: false,
          status: 503,
          error: "unavailable",
          response: Response.json({ error: { message: "unavailable" } }, { status: 503 }),
        };
      })
      .mockImplementationOnce(async () => {
        seenDuringCandidate2 = allLiveEntries();
        return { success: true, response: Response.json({ ok: true }) };
      });

    await handleChat(postChat({ model: "assistant", messages: [{ role: "user", content: "hi" }] }, { signal: abortController.signal }));
    expect(seenDuringCandidate2).toEqual([]);
    expect(allLiveEntries()).toHaveLength(0);

    // 3. Normal completion removes the abort listener from request.signal
    fx.combos = {};
    const trackedReq = postChat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "done" }] }, { signal: new AbortController().signal });
    const addSpy = vi.spyOn(trackedReq.signal, "addEventListener");
    const removeSpy = vi.spyOn(trackedReq.signal, "removeEventListener");
    mocks.core.mockResolvedValueOnce({ success: true, response: Response.json({ ok: true }) });

    await handleChat(trackedReq);
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith("abort", addSpy.mock.calls[0][1]);
  });

  it("isolates fusion panel calls from liveRegistry metadata and onFirstToken while preserving judge tracking", async () => {
    fx.combos = { council: ["openai/panel-a", "anthropic/panel-b"] };
    fx.settings = {
      requireApiKey: false,
      comboStrategy: "fallback",
      comboStrategies: { council: { fallbackStrategy: "fusion", judgeModel: "openai/judge-1" } },
      ccFilterNaming: false,
    };

    const observations = [];
    let judgeStreamController;
    mocks.core.mockImplementation(async ({ modelInfo, clientRawRequest, onFirstToken }) => {
      observations.push({
        model: modelInfo.model,
        isFusionPanel: Boolean(clientRawRequest?.isFusionPanel),
        hasOnFirstToken: typeof onFirstToken === "function",
        liveSnapshot: allLiveEntries().map((e) => ({ combo: e.combo, model: e.model, provider: e.provider })),
      });
      if (clientRawRequest?.isFusionPanel) {
        return {
          success: true,
          response: Response.json({ choices: [{ message: { content: `panel answer from ${modelInfo.model}` } }] }),
        };
      }
      const stream = new ReadableStream({
        start(controller) { judgeStreamController = controller; },
      });
      return {
        success: true,
        response: new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      };
    });

    const res = await handleChat(postChat({
      model: "council",
      stream: true,
      messages: [{ role: "user", content: "synthesize" }],
    }));

    expect(res.status).toBe(200);
    const panelObs = observations.filter((o) => o.isFusionPanel);
    const judgeObs = observations.filter((o) => !o.isFusionPanel);
    expect(panelObs).toHaveLength(2);
    for (const obs of panelObs) {
      expect(obs.hasOnFirstToken).toBe(false);
      // Panels must not overwrite the outer combo entry in liveRegistry
      expect(obs.liveSnapshot).toEqual([{ combo: "council", model: "council", provider: null }]);
    }
    expect(judgeObs).toHaveLength(1);
    expect(judgeObs[0].hasOnFirstToken).toBe(true);
    expect(judgeObs[0].liveSnapshot).toEqual([{ combo: "council", model: "openai/judge-1", provider: "openai" }]);

    judgeStreamController.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"final"}}]}\n\n'));
    judgeStreamController.close();
    const reader = res.body.getReader();
    while (!(await reader.read()).done);
    expect(allLiveEntries()).toHaveLength(0);
  });
});
