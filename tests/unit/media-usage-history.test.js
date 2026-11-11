import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchCore: vi.fn(),
  sttCore: vi.fn(),
  observeRequest: vi.fn(),
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: mocks.searchCore,
}));

vi.mock("open-sse/handlers/sttCore.js", () => ({
  handleSttCore: mocks.sttCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/lib/piiGuard/observe.js", () => ({
  observeRequest: mocks.observeRequest,
  blockMessage: (names, chat = true) => `pii-guard blocked: ${names.join(", ")}.${chat ? " /rewind" : ""}`,
}));

let adapter;
let handleSearch;
let handleStt;
let localDb;
let originalPiiGuardModule;

beforeAll(async () => {
  const dbDriver = await import("@/lib/db/driver.js");
  adapter = await dbDriver.getAdapter();
  localDb = await import("@/lib/localDb");
  ({ handleSearch } = await import("@/sse/handlers/search.js"));
  ({ handleStt } = await import("@/sse/handlers/stt.js"));
}, 120000);

beforeEach(async () => {
  vi.clearAllMocks();
  originalPiiGuardModule = process.env.PII_GUARD_MODULE;
  delete process.env.PII_GUARD_MODULE;

  adapter.exec(`
    DELETE FROM usageHistory;
    DELETE FROM providerConnections;
    DELETE FROM combos;
    DELETE FROM apiKeys;
    DELETE FROM settings;
    DELETE FROM kv;
  `);
  await localDb.updateSettings({ requireApiKey: false, comboStrategy: "fallback" });

  mocks.observeRequest.mockResolvedValue({ recordRouting: vi.fn() });
  mocks.searchCore.mockResolvedValue({ success: true, response: Response.json({ results: [] }) });
  mocks.sttCore.mockResolvedValue({ success: true, response: Response.json({ text: "hello" }) });
});

afterEach(() => {
  if (originalPiiGuardModule === undefined) delete process.env.PII_GUARD_MODULE;
  else process.env.PII_GUARD_MODULE = originalPiiGuardModule;
});

function readUsageRows() {
  return adapter.all("SELECT * FROM usageHistory ORDER BY rowid");
}

function makeSearchRequest(body, headers = {}) {
  return new Request("http://localhost:20128/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeSttRequest({ model = "openai/whisper-1", fileContent = "secret-audio-bytes", sessionId = null, headers = {}, signal } = {}) {
  const form = new FormData();
  if (model !== undefined) form.set("model", model);
  if (fileContent !== undefined) form.set("file", new File([fileContent], "clip.wav", { type: "audio/wav" }));
  if (sessionId) form.set("session_id", sessionId);
  return new Request("http://localhost:20128/v1/audio/transcriptions", {
    method: "POST",
    headers,
    body: form,
    ...(signal ? { signal } : {}),
  });
}

describe("B9 media usageHistory (/v1/search & /v1/audio/transcriptions)", () => {
  it("records a single ok row with zero tokens/cost and explicit session hash for no-auth search", async () => {
    const res = await handleSearch(makeSearchRequest(
      { provider: "searxng", query: "sensitive local query" },
      { "x-session-id": "search-session-123", "user-agent": "search-agent/1.0" },
    ));

    expect(res.status).toBe(200);
    const rows = readUsageRows();
    expect(rows).toHaveLength(1);

    const expectedSession = createHash("sha256").update("search-session-123").digest("hex").slice(0, 12);
    const meta = JSON.parse(rows[0].meta);
    expect(rows[0]).toMatchObject({
      provider: "searxng",
      model: "searxng",
      endpoint: "/v1/search",
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      status: "ok",
      session: expectedSession,
    });
    expect(meta).toMatchObject({
      status: "ok",
      ua: "search-agent/1.0",
      session: expectedSession,
      latency: { ttftMs: null, stream: false },
    });
    expect(meta.latency.totalMs).toEqual(expect.any(Number));
    expect(rows[0].meta).not.toContain("sensitive local query");
    expect(rows[0].tokens).not.toContain("sensitive local query");
  });

  it("leaves session null for stateless search calls without explicit session markers", async () => {
    const res = await handleSearch(makeSearchRequest({ provider: "searxng", query: "stateless query" }));
    expect(res.status).toBe(200);

    const rows = readUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session).toBeNull();
    expect(JSON.parse(rows[0].meta).session).toBeUndefined();
  });

  it("records one logical ok row across credentialed multi-account search fallback", async () => {
    const acc1 = await localDb.createProviderConnection({
      provider: "tavily",
      authType: "apikey",
      name: "tavily-1",
      apiKey: "dummy-provider-key",
      isActive: true,
    });
    const acc2 = await localDb.createProviderConnection({
      provider: "tavily",
      authType: "apikey",
      name: "tavily-2",
      apiKey: "dummy-provider-key",
      isActive: true,
    });

    mocks.searchCore
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "secret upstream rate limit",
        response: Response.json({ error: "rate limit" }, { status: 429 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: Response.json({ results: [{ title: "ok" }] }),
      });

    const res = await handleSearch(makeSearchRequest({ provider: "tavily", query: "fallback query" }));
    expect(res.status).toBe(200);
    expect(mocks.searchCore).toHaveBeenCalledTimes(2);

    const rows = readUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "tavily",
      model: "tavily",
      status: "ok",
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    });
    expect([acc1.id, acc2.id]).toContain(rows[0].connectionId);
    expect(rows[0].connectionId).not.toBe(mocks.searchCore.mock.calls[0][0].credentials.connectionId);
  });

  it("records one logical row for combo search fallback and total combo failure without error text", async () => {
    await localDb.createProviderConnection({
      provider: "tavily",
      authType: "apikey",
      name: "tavily-c",
      apiKey: "dummy-provider-key",
      isActive: true,
    });
    await localDb.createProviderConnection({
      provider: "perplexity",
      authType: "apikey",
      name: "pplx-c",
      apiKey: "dummy-provider-key",
      isActive: true,
    });
    await localDb.createCombo({
      name: "search-mix",
      kind: "webSearch",
      models: ["tavily", "perplexity"],
    });

    mocks.searchCore
      .mockResolvedValueOnce({
        success: false,
        status: 503,
        error: "secret upstream 503",
        response: Response.json({ error: "unavailable" }, { status: 503 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: Response.json({ results: [] }),
      });

    const okRes = await handleSearch(makeSearchRequest({ model: "search-mix", query: "combo success query" }));
    expect(okRes.status).toBe(200);
    let rows = readUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "perplexity",
      model: "perplexity",
      status: "ok",
      cost: 0,
    });
    expect(JSON.parse(rows[0].meta).combo).toBe("search-mix");

    adapter.exec("DELETE FROM usageHistory");
    mocks.searchCore
      .mockResolvedValueOnce({
        success: false,
        status: 502,
        error: "private upstream failure payload",
        response: Response.json({ error: "bad gateway" }, { status: 502 }),
      })
      .mockResolvedValueOnce({
        success: false,
        status: 504,
        error: "private second upstream error",
        response: Response.json({ error: "timeout" }, { status: 504 }),
      });

    const failRes = await handleSearch(makeSearchRequest({ model: "search-mix", query: "combo fail secret query" }));
    expect(failRes.status).toBeGreaterThanOrEqual(500);
    rows = readUsageRows();
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].meta);
    expect(rows[0]).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    });
    expect(meta).toMatchObject({
      status: "error",
      combo: "search-mix",
    });
    expect(rows[0].meta).not.toContain("private upstream failure payload");
    expect(rows[0].meta).not.toContain("combo fail secret query");
  });

  it("logs sanitized early search errors and never records unauthenticated 401s when requireApiKey=true", async () => {
    const missingQueryRes = await handleSearch(makeSearchRequest({ provider: "searxng", query: "   " }));
    expect(missingQueryRes.status).toBe(400);

    const unknownProviderRes = await handleSearch(makeSearchRequest({ provider: "client-secret-provider", query: "hello" }));
    expect(unknownProviderRes.status).toBe(400);

    process.env.PII_GUARD_MODULE = "/fake-scanner.js";
    mocks.observeRequest.mockResolvedValueOnce({ blocked: ["email"] });
    const piiBlockedRes = await handleSearch(makeSearchRequest({ provider: "searxng", query: "email {{pii:email#123456}}" }));
    expect(piiBlockedRes.status).toBe(400);
    delete process.env.PII_GUARD_MODULE;

    const restrictedKey = await localDb.createApiKey("search-restricted", "machine-1");
    await localDb.updateApiKey(restrictedKey.id, { access: { restricted: true, allow: ["tavily"] } });
    const deniedRes = await handleSearch(makeSearchRequest(
      { provider: "searxng", query: "blocked query" },
      { Authorization: `Bearer ${restrictedKey.key}` },
    ));
    expect(deniedRes.status).toBe(403);

    const rows = readUsageRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ provider: "searxng", model: "searxng", status: "400" });
    expect(JSON.parse(rows[0].meta).errorKind).toBe("bad_request");

    expect(rows[1]).toMatchObject({ provider: "unknown", model: "invalid", status: "400" });
    expect(JSON.parse(rows[1].meta).errorKind).toBe("not_found");
    expect(JSON.stringify(rows[1])).not.toContain("client-secret-provider");

    expect(rows[2]).toMatchObject({ provider: "searxng", model: "searxng", status: "400" });
    expect(JSON.parse(rows[2].meta).errorKind).toBe("blocked");

    expect(rows[3]).toMatchObject({ provider: "searxng", model: "searxng", status: "403", apiKey: restrictedKey.key });
    expect(JSON.parse(rows[3].meta).errorKind).toBe("blocked");

    adapter.exec("DELETE FROM usageHistory");
    await localDb.updateSettings({ requireApiKey: true });

    const missingKeyRes = await handleSearch(makeSearchRequest({ provider: "searxng", query: "unauth" }));
    const badKeyRes = await handleSearch(makeSearchRequest(
      { provider: "searxng", query: "unauth" },
      { Authorization: "Bearer invalid-key-xyz" },
    ));
    const badJsonUnauthRes = await handleSearch(makeSearchRequest("{not-json"));

    expect(missingKeyRes.status).toBe(401);
    expect(badKeyRes.status).toBe(401);
    expect(badJsonUnauthRes.status).toBe(400);
    expect(readUsageRows()).toHaveLength(0);
  });

  it("records one ok row across STT multi-account fallback and isolates audio/transcript payloads", async () => {
    const acc1 = await localDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-1",
      apiKey: "dummy-provider-key",
      isActive: true,
    });
    const acc2 = await localDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-2",
      apiKey: "dummy-provider-key",
      isActive: true,
    });

    mocks.sttCore
      .mockResolvedValueOnce({ success: false, status: 503, error: "secret stt 503" })
      .mockResolvedValueOnce({ success: true, response: Response.json({ text: "confidential transcript" }) });

    const res = await handleStt(makeSttRequest({
      model: "openai/whisper-1",
      fileContent: "raw-secret-audio-payload",
      sessionId: "stt-session-abc",
      headers: { "user-agent": "stt-client/2.0" },
    }));

    expect(res.status).toBe(200);
    expect(mocks.sttCore).toHaveBeenCalledTimes(2);

    const rows = readUsageRows();
    expect(rows).toHaveLength(1);
    const expectedSession = createHash("sha256").update("stt-session-abc").digest("hex").slice(0, 12);
    expect(rows[0]).toMatchObject({
      provider: "openai",
      model: "whisper-1",
      endpoint: "/v1/audio/transcriptions",
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      status: "ok",
      session: expectedSession,
    });
    expect([acc1.id, acc2.id]).toContain(rows[0].connectionId);
    expect(rows[0].connectionId).not.toBe(mocks.sttCore.mock.calls[0][0].credentials.connectionId);
    expect(JSON.stringify(rows[0])).not.toContain("raw-secret-audio-payload");
    expect(JSON.stringify(rows[0])).not.toContain("confidential transcript");
  });

  it("sanitizes unknown STT models, logs abort/blocked/upstream failures once, and suppresses 401 usage when requireApiKey=true", async () => {
    const invalidFormatRes = await handleStt(makeSttRequest({ model: "/secret-unparsed-model" }));
    expect(invalidFormatRes.status).toBe(400);

    const unknownOpenAiModelRes = await handleStt(makeSttRequest({ model: "openai/gpt-4o" }));
    expect(unknownOpenAiModelRes.status).toBe(400);

    await localDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-stt",
      apiKey: "dummy-provider-key",
      isActive: true,
    });
    mocks.sttCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      error: "private upstream stt error",
      response: Response.json({ error: "bad gateway" }, { status: 502 }),
    });
    const upstreamFailRes = await handleStt(makeSttRequest({ model: "openai/whisper-1" }));
    expect(upstreamFailRes.status).toBe(502);

    adapter.exec("DELETE FROM providerConnections");
    await localDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-stt-abort",
      apiKey: "dummy-provider-key",
      isActive: true,
    });
    const controller = new AbortController();
    mocks.sttCore.mockImplementationOnce(async () => {
      controller.abort();
      return { success: false, status: 500, error: "cancelled" };
    });
    const abortedRes = await handleStt(makeSttRequest({ model: "openai/whisper-1", signal: controller.signal }));
    expect(abortedRes.status).toBe(504);

    const restrictedKey = await localDb.createApiKey("stt-restricted", "machine-2");
    await localDb.updateApiKey(restrictedKey.id, { access: { restricted: true, allow: ["groq/whisper-large-v3"] } });
    const blockedRes = await handleStt(makeSttRequest({
      model: "openai/whisper-1",
      headers: { Authorization: `Bearer ${restrictedKey.key}` },
    }));
    expect(blockedRes.status).toBe(403);

    const rows = readUsageRows();
    expect(rows).toHaveLength(5);

    expect(rows[0]).toMatchObject({ provider: "unknown", model: "invalid", status: "400" });
    expect(JSON.parse(rows[0].meta).errorKind).toBe("not_found");
    expect(JSON.stringify(rows[0])).not.toContain("secret-unparsed-model");

    expect(rows[1]).toMatchObject({ provider: "openai", model: "invalid", status: "400" });
    expect(JSON.parse(rows[1].meta).errorKind).toBe("auth");
    expect(JSON.stringify(rows[1])).not.toContain("gpt-4o");

    expect(rows[2]).toMatchObject({ provider: "openai", model: "whisper-1", status: "502" });
    expect(JSON.parse(rows[2].meta)).toMatchObject({ status: "error", errorKind: "upstream_5xx" });
    expect(rows[2].meta).not.toContain("private upstream stt error");

    expect(rows[3]).toMatchObject({ provider: "openai", model: "whisper-1", status: "504" });
    expect(JSON.parse(rows[3].meta)).toMatchObject({ status: "aborted", errorKind: "aborted" });

    expect(rows[4]).toMatchObject({ provider: "openai", model: "whisper-1", status: "403", apiKey: restrictedKey.key });
    expect(JSON.parse(rows[4].meta).errorKind).toBe("blocked");

    adapter.exec("DELETE FROM usageHistory");
    await localDb.updateSettings({ requireApiKey: true });

    const missingKeyRes = await handleStt(makeSttRequest({ model: "openai/whisper-1" }));
    const badKeyRes = await handleStt(makeSttRequest({
      model: "openai/whisper-1",
      headers: { Authorization: "Bearer nope" },
    }));
    const badMultipartUnauthRes = await handleStt(new Request("http://localhost:20128/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-multipart",
    }));

    expect(missingKeyRes.status).toBe(401);
    expect(badKeyRes.status).toBe(401);
    expect(badMultipartUnauthRes.status).toBe(400);
    expect(readUsageRows()).toHaveLength(0);
  });
});
