import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { connections: [] };
  return {
    state,
    getProviderConnections: vi.fn(async () => structuredClone(state.connections)),
    updateProviderConnection: vi.fn(async (id, patch) => {
      const connection = state.connections.find((item) => item.id === id);
      if (!connection) return null;
      Object.assign(connection, patch);
      return structuredClone(connection);
    }),
    setOpenCodeGoPaidQuotaLockIfCredentialFingerprint: vi.fn(async (id, fingerprint, lock, health) => {
      const connection = state.connections.find((item) => item.id === id);
      if (!connection || mocks.getOpenCodeGoCredentialFingerprint(connection) !== fingerprint) {
        return { updated: false, connection: null };
      }
      Object.assign(connection, health, { quotaLock_opencodeGoPaid: lock });
      return { updated: true, connection: structuredClone(connection) };
    }),
    observeOpenCodeGoPaidQuotaLockIfGeneration: vi.fn(async (id, generation, nextLock, health) => {
      const connection = state.connections.find((item) => item.id === id);
      const currentLock = connection?.quotaLock_opencodeGoPaid;
      if (!currentLock || currentLock.generation !== generation) return { updated: false, connection: null };
      Object.assign(connection, health, { quotaLock_opencodeGoPaid: nextLock });
      return { updated: true, connection: structuredClone(connection) };
    }),
    updateOpenCodeGoPaidQuotaLockIfGeneration: vi.fn(async (id, generation, patch) => {
      const connection = state.connections.find((item) => item.id === id);
      const lock = connection?.quotaLock_opencodeGoPaid;
      if (!lock || lock.generation !== generation) return { updated: false, connection: null };
      connection.quotaLock_opencodeGoPaid = { ...lock, ...patch };
      return { updated: true, connection: structuredClone(connection) };
    }),
    clearOpenCodeGoPaidQuotaLockIfGeneration: vi.fn(async (id, generation) => {
      const connection = state.connections.find((item) => item.id === id);
      const lock = connection?.quotaLock_opencodeGoPaid;
      if (!lock || lock.generation !== generation) return { updated: false, connection: null };
      delete connection.quotaLock_opencodeGoPaid;
      return { updated: true, connection: structuredClone(connection) };
    }),
    getSettings: vi.fn(async () => ({})),
    getProxyPools: vi.fn(async () => []),
    validateApiKey: vi.fn(),
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
    pickProxyPoolId: vi.fn(),
    getOpenCodeGoUsage: vi.fn(async () => ({ message: "not available" })),
  };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  setOpenCodeGoPaidQuotaLockIfCredentialFingerprint: mocks.setOpenCodeGoPaidQuotaLockIfCredentialFingerprint,
  observeOpenCodeGoPaidQuotaLockIfGeneration: mocks.observeOpenCodeGoPaidQuotaLockIfGeneration,
  updateOpenCodeGoPaidQuotaLockIfGeneration: mocks.updateOpenCodeGoPaidQuotaLockIfGeneration,
  clearOpenCodeGoPaidQuotaLockIfGeneration: mocks.clearOpenCodeGoPaidQuotaLockIfGeneration,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider === "ocg" ? "opencode-go" : provider,
}));
vi.mock("open-sse/services/usage/opencode-go.js", () => ({ getOpenCodeGoUsage: mocks.getOpenCodeGoUsage }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const {
  clearAccountError,
  completeOpenCodeGoQuotaProbe,
  getProviderCredentials,
  markAccountUnavailable,
} = await import("../../src/sse/services/auth.js");
const { getModelQuotaScope } = await import("../../open-sse/config/providerModels.js");
const { OPENCODE_GO_PROBE_LEASE_MS } = await import("../../open-sse/config/errorConfig.js");
const { getOpenCodeGoCredentialFingerprint } = await import("../../src/lib/db/credentialFingerprint.js");
mocks.getOpenCodeGoCredentialFingerprint = getOpenCodeGoCredentialFingerprint;

function connection(id, quotaLock = null) {
  return {
    id,
    provider: "opencode-go",
    isActive: true,
    authType: "apikey",
    apiKey: "test-key",
    priority: 1,
    ...(quotaLock ? { quotaLock_opencodeGoPaid: quotaLock } : {}),
  };
}

function lock(retryAt, generation = "generation-a") {
  return {
    version: 1,
    reason: "GoUsageLimitError",
    limitName: "weekly",
    observedAt: "2026-11-08T00:00:00.000Z",
    retryAt,
    resetAt: null,
    generation,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.connections = [];
  mocks.getSettings.mockResolvedValue({});
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getOpenCodeGoUsage.mockResolvedValue({ message: "not available" });
});

describe("OpenCode Go paid quota lock", () => {
  it("uses registry metadata first and the free suffix for passthrough ids", () => {
    expect(getModelQuotaScope("ocg", "space-bunny-free")).toBe("free");
    expect(getModelQuotaScope("opencode-go", "beam-free")).toBe("free");
    expect(getModelQuotaScope("opencode-go", "beam-free(high)")).toBe("free");
    expect(getModelQuotaScope("opencode-go", "new-paid-model")).toBe("paid");
    expect(getModelQuotaScope("openai", "beam-free")).toBeNull();
  });

  it("blocks every paid model on one account while keeping free models available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-locked", lock("2026-11-09T00:00:00.000Z"))];
    try {
      await expect(getProviderCredentials("ocg", null, "an-unseen-paid-model")).resolves.toMatchObject({
        allRateLimited: true,
        retryAfter: "2026-11-09T00:00:00.000Z",
      });
      await expect(getProviderCredentials("opencode-go", null, "beam-free")).resolves.toMatchObject({
        connectionId: "go-locked",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves other accounts eligible for paid requests", async () => {
    mocks.state.connections = [
      connection("go-locked", lock("2099-01-01T00:00:00.000Z")),
      { ...connection("go-healthy"), priority: 2 },
    ];
    await expect(getProviderCredentials("opencode-go", null, "new-paid-model")).resolves.toMatchObject({
      connectionId: "go-healthy",
    });
  });

  it("assigns concurrent due probes to separate connections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [
      connection("go-due-a", lock("2026-11-08T11:59:00.000Z", "generation-a")),
      { ...connection("go-due-b", lock("2026-11-08T11:59:00.000Z", "generation-b")), priority: 2 },
    ];
    try {
      const [first, second] = await Promise.all([
        getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true }),
        getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true }),
      ]);

      expect(first.connectionId).not.toBe(second.connectionId);
      expect(first.quotaProbe).toEqual(expect.objectContaining({ token: expect.any(String) }));
      expect(second.quotaProbe).toEqual(expect.objectContaining({ token: expect.any(String) }));
      await expect(getProviderCredentials("opencode-go", null, "paid-model")).resolves.toMatchObject({
        allRateLimited: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a due lock for non-chat callers while allowing chat to acquire its probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-non-chat", lock("2026-11-08T11:59:00.000Z"))];
    try {
      const nonChatCredentials = await getProviderCredentials("opencode-go", null, "paid-model");
      expect(nonChatCredentials).toMatchObject({ allRateLimited: true });
      expect(nonChatCredentials).not.toHaveProperty("quotaProbe");

      const chatCredentials = await getProviderCredentials(
        "opencode-go", null, "paid-model", { allowQuotaProbe: true },
      );
      expect(chatCredentials.connectionId).toBe("go-non-chat");
      expect(chatCredentials.quotaProbe).toMatchObject({ generation: "generation-a", token: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the latest blocker per connection and earliest retry across accounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    const modelLockUntil = "2026-11-08T20:00:00.000Z";
    mocks.state.connections = [
      {
        ...connection("go-a", lock("2026-11-08T19:00:00.000Z")),
        modelLock_paid: modelLockUntil,
      },
      connection("go-b", lock("2026-11-08T21:00:00.000Z")),
    ];
    try {
      await expect(getProviderCredentials("opencode-go", null, "paid")).resolves.toMatchObject({
        allRateLimited: true,
        retryAfter: modelLockUntil,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a six-hour fallback before an asynchronous usage lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-observe")];
    try {
      const credentials = await getProviderCredentials("opencode-go", null, "paid-model");
      await markAccountUnavailable(
        "go-observe", 429, "Go usage limit exceeded", "opencode-go", "paid-model", null,
        { kind: "opencode-go-paid", limitName: "weekly" }, null, credentials.quotaCredentialFingerprint,
      );
      expect(mocks.setOpenCodeGoPaidQuotaLockIfCredentialFingerprint).toHaveBeenCalledWith(
        "go-observe",
        credentials.quotaCredentialFingerprint,
        expect.objectContaining({
          version: 1,
          reason: "GoUsageLimitError",
          retryAt: "2026-11-08T18:00:00.000Z",
          resetAt: null,
          generation: expect.any(String),
        }),
        expect.objectContaining({ testStatus: "unavailable", errorCode: 429 }),
      );
      expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["credential-like", "sk-abc123-secret"],
    ["long junk", "x".repeat(256)],
  ])("stores null for an unrecognized quota limit (%s)", async (_label, limitName) => {
    mocks.state.connections = [connection("go-invalid-limit")];
    const credentials = await getProviderCredentials("opencode-go", null, "paid-model");

    await markAccountUnavailable(
      "go-invalid-limit", 429, "upstream free-form error", "opencode-go", "paid-model", null,
      { kind: "opencode-go-paid", limitName }, null, credentials.quotaCredentialFingerprint,
    );

    expect(mocks.state.connections[0].quotaLock_opencodeGoPaid).toMatchObject({
      reason: "GoUsageLimitError",
      limitName: null,
    });
    expect(mocks.state.connections[0].quotaLock_opencodeGoPaid.reason).not.toContain("upstream free-form error");
    expect(mocks.state.connections[0].lastError).toBe("upstream free-form error");
  });

  it("upgrades the fallback to the matching usage API reset", async () => {
    const resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mocks.state.connections = [connection("go-usage")];
    mocks.getOpenCodeGoUsage.mockResolvedValue({
      quotas: { Weekly: { used: 100, resetAt } },
    });
    const credentials = await getProviderCredentials("opencode-go", null, "paid-model");
    await markAccountUnavailable(
      "go-usage", 429, "Go usage limit exceeded", "opencode-go", "paid-model", null,
      { kind: "opencode-go-paid", limitName: "weekly" }, null, credentials.quotaCredentialFingerprint,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.updateOpenCodeGoPaidQuotaLockIfGeneration).toHaveBeenCalledWith(
      "go-usage",
      expect.any(String),
      { retryAt: resetAt, resetAt },
    );
  });

  it("does not apply an old 429 to a replacement API key", async () => {
    mocks.state.connections = [connection("go-replaced")];
    const selected = await getProviderCredentials("opencode-go", null, "paid-model");
    mocks.state.connections[0].apiKey = "replacement-key";

    await markAccountUnavailable(
      "go-replaced", 429, "Go usage limit exceeded", "opencode-go", "paid-model", null,
      { kind: "opencode-go-paid", limitName: "weekly" }, null, selected.quotaCredentialFingerprint,
    );

    expect(mocks.setOpenCodeGoPaidQuotaLockIfCredentialFingerprint).toHaveBeenCalledWith(
      "go-replaced",
      selected.quotaCredentialFingerprint,
      expect.objectContaining({ reason: "GoUsageLimitError" }),
      expect.any(Object),
    );
    expect(mocks.state.connections[0].apiKey).toBe("replacement-key");
    expect(mocks.state.connections[0]).not.toHaveProperty("quotaLock_opencodeGoPaid");
    expect(mocks.getOpenCodeGoUsage).not.toHaveBeenCalled();
  });

  it("admits one paid probe and returns its lease expiry to concurrent requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-probe", lock("2026-11-08T11:59:00.000Z"))];
    try {
      const first = await getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true });
      expect(first.quotaProbe).toMatchObject({ generation: "generation-a", token: expect.any(String) });
      await expect(getProviderCredentials("opencode-go", null, "paid-model")).resolves.toMatchObject({
        allRateLimited: true,
        retryAfter: "2026-11-08T12:02:00.000Z",
      });
      await completeOpenCodeGoQuotaProbe("go-probe", first.quotaProbe, "inconclusive");
      expect(mocks.state.connections[0].quotaLock_opencodeGoPaid.retryAt).toBe("2026-11-08T12:00:30.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews quota suppression after a paid probe returns the typed quota error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-renew", lock("2026-11-08T11:59:00.000Z", "old-generation"))];
    try {
      const probeCredentials = await getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true });
      await markAccountUnavailable(
        "go-renew", 429, "Go usage limit exceeded", "opencode-go", "paid-model", null,
        { kind: "opencode-go-paid", limitName: "weekly" }, probeCredentials.quotaProbe,
        probeCredentials.quotaCredentialFingerprint,
      );
      const renewed = mocks.state.connections[0].quotaLock_opencodeGoPaid;
      expect(renewed.generation).not.toBe("old-generation");
      expect(renewed.retryAt).toBe("2026-11-08T18:00:00.000Z");
      expect(mocks.observeOpenCodeGoPaidQuotaLockIfGeneration).toHaveBeenCalledWith(
        "go-renew",
        "old-generation",
        expect.objectContaining({ generation: expect.any(String) }),
        expect.objectContaining({ testStatus: "unavailable" }),
      );

      await completeOpenCodeGoQuotaProbe("go-renew", probeCredentials.quotaProbe, "quota-error");
      expect(mocks.state.connections[0].quotaLock_opencodeGoPaid).toEqual(renewed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an expired probe clear a lock owned by a later probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-probe-race", lock("2026-11-08T11:59:00.000Z", "generation-race"))];
    try {
      const probeA = await getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true });
      await vi.advanceTimersByTimeAsync(OPENCODE_GO_PROBE_LEASE_MS + 1);
      const probeB = await getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true });

      expect(probeB.quotaProbe.token).not.toBe(probeA.quotaProbe.token);
      await expect(completeOpenCodeGoQuotaProbe("go-probe-race", probeA.quotaProbe, "success"))
        .resolves.toMatchObject({ updated: false });
      expect(mocks.state.connections[0].quotaLock_opencodeGoPaid.generation).toBe("generation-race");

      await markAccountUnavailable(
        "go-probe-race", 429, "Go usage limit exceeded", "opencode-go", "paid-model", null,
        { kind: "opencode-go-paid", limitName: "weekly" }, probeB.quotaProbe,
        probeB.quotaCredentialFingerprint,
      );
      const renewedLock = mocks.state.connections[0].quotaLock_opencodeGoPaid;
      expect(renewedLock.generation).not.toBe("generation-race");
      expect(renewedLock.reason).toBe("GoUsageLimitError");
      await completeOpenCodeGoQuotaProbe("go-probe-race", probeB.quotaProbe, "quota-error");
      expect(mocks.state.connections[0].quotaLock_opencodeGoPaid).toEqual(renewedLock);
    } finally {
      vi.useRealTimers();
    }
  });

  it("relocks after a stale probe reports exhaustion against a cleared lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    mocks.state.connections = [connection("go-probe-stale", lock("2026-11-08T11:59:00.000Z", "generation-old"))];
    try {
      const staleProbe = await getProviderCredentials(
        "opencode-go", null, "paid-model", { allowQuotaProbe: true },
      );
      await vi.advanceTimersByTimeAsync(OPENCODE_GO_PROBE_LEASE_MS + 1);
      delete mocks.state.connections[0].quotaLock_opencodeGoPaid;

      await markAccountUnavailable(
        "go-probe-stale", 429, "Go usage limit exceeded", "opencode-go", "paid-model", null,
        { kind: "opencode-go-paid", limitName: "weekly" }, staleProbe.quotaProbe,
        staleProbe.quotaCredentialFingerprint,
      );

      expect(mocks.observeOpenCodeGoPaidQuotaLockIfGeneration).not.toHaveBeenCalled();
      expect(mocks.setOpenCodeGoPaidQuotaLockIfCredentialFingerprint).toHaveBeenCalledWith(
        "go-probe-stale",
        staleProbe.quotaCredentialFingerprint,
        expect.objectContaining({ reason: "GoUsageLimitError" }),
        expect.any(Object),
      );
      expect(mocks.state.connections[0].quotaLock_opencodeGoPaid).toMatchObject({
        reason: "GoUsageLimitError",
        limitName: "weekly",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears only a matching generation after paid success", async () => {
    mocks.state.connections = [connection("go-clear", lock("2026-11-08T11:00:00.000Z", "current"))];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    try {
      const credentials = await getProviderCredentials("opencode-go", null, "paid-model", { allowQuotaProbe: true });
      await expect(completeOpenCodeGoQuotaProbe("go-clear", { generation: "current", token: "old" }, "success"))
        .resolves.toMatchObject({ updated: false });
      expect(mocks.state.connections[0].quotaLock_opencodeGoPaid.generation).toBe("current");

      await expect(completeOpenCodeGoQuotaProbe("go-clear", credentials.quotaProbe, "success"))
        .resolves.toMatchObject({ updated: true });
      expect(mocks.state.connections[0]).not.toHaveProperty("quotaLock_opencodeGoPaid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a paid lock after free success and uses ordinary backoff for a free quota error", async () => {
    const paidLock = lock("2099-01-01T00:00:00.000Z");
    const freeAccount = { ...connection("go-free", paidLock), testStatus: "unavailable", lastError: "old quota" };
    mocks.state.connections = [freeAccount];
    await clearAccountError("go-free", { _connection: structuredClone(freeAccount) }, "beam-free");
    expect(freeAccount.quotaLock_opencodeGoPaid).toEqual(paidLock);
    expect(freeAccount.testStatus).toBe("unavailable");

    await markAccountUnavailable(
      "go-free", 429, "Go usage limit exceeded", "opencode-go", "beam-free", null,
      { kind: "opencode-go-paid", limitName: "weekly" },
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "go-free",
      expect.objectContaining({ "modelLock_beam-free": expect.any(String) }),
    );
    expect(mocks.updateProviderConnection.mock.calls.at(-1)[1]).not.toHaveProperty("quotaLock_opencodeGoPaid");
  });
});
