import { beforeEach, describe, expect, it, vi } from "vitest";

const overrideMocks = vi.hoisted(() => ({
  loadOverrides: vi.fn(),
  resolveSessionOverride: vi.fn(),
  markActive: vi.fn(),
}));

vi.mock("@/lib/agents/overrideStore.js", () => overrideMocks);

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { getStickyComboModel } from "../../open-sse/services/systemoneRouter.js";

const log = { info() {}, warn() {}, debug() {}, error() {} };
const normal = ["openai/a", "anthropic/b", "openai/c"];

function jsonResponse(ok = true) {
  return new Response(JSON.stringify(ok
    ? { choices: [{ message: { content: "ok" } }] }
    : { error: { message: "down" } }), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

async function route(opts = {}) {
  const tried = [];
  const failed = new Set(opts.failedModels || []);
  const response = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: normal,
    handleSingleModel: async (_body, model) => { tried.push(model); return jsonResponse(!failed.has(model)); },
    log,
    comboName: "assistant",
    comboStrategy: "fallback",
    sessionId: "session-override",
    rawSession: "claude:550e8400-e29b-41d4-a716-446655440000",
    ...opts,
  });
  return { response, tried };
}

describe("combo session override wiring", () => {
  beforeEach(() => {
    resetComboRotation();
    vi.clearAllMocks();
    overrideMocks.loadOverrides.mockResolvedValue(undefined);
    overrideMocks.resolveSessionOverride.mockReturnValue(null);
  });

  it("routes member mode first, then retains normal fallback order and pins the target", async () => {
    overrideMocks.resolveSessionOverride.mockReturnValue({
      models: ["anthropic/b", "openai/a", "openai/c"],
      override: { mode: "member", model: "anthropic/b" },
    });
    const { tried } = await route();
    expect(tried).toEqual(["anthropic/b"]);
    expect(getStickyComboModel("assistant", "session-override", normal)).toBe("anthropic/b");
    expect(overrideMocks.markActive).toHaveBeenCalledWith("claude:550e8400-e29b-41d4-a716-446655440000", "assistant");
  });

  it("routes the concrete identity authorized for an alias", async () => {
    overrideMocks.resolveSessionOverride.mockReturnValue({
      models: ["anthropic/claude-sonnet-4-20250514"],
      override: { mode: "override", model: "model-alias", fallback: false },
    });
    const { tried } = await route();
    expect(tried).toEqual(["anthropic/claude-sonnet-4-20250514"]);
  });

  it("keeps strict mode to the target unless its resolver supplies fallbacks", async () => {
    overrideMocks.resolveSessionOverride.mockReturnValue({
      models: ["openai/c"],
      override: { mode: "override", model: "openai/c", fallback: false },
    });
    expect((await route({ failedModels: ["openai/c"] })).tried).toEqual(["openai/c"]);

    overrideMocks.resolveSessionOverride.mockReturnValue({
      models: ["openai/c", "openai/a", "anthropic/b"],
      override: { mode: "override", model: "openai/c", fallback: true },
    });
    expect((await route({ failedModels: ["openai/c"] })).tried).toEqual(["openai/c", "openai/a"]);
  });

  it("loads and resolves controls at every nested combo level", async () => {
    const calls = [];
    overrideMocks.resolveSessionOverride.mockImplementation(({ combo }) => {
      calls.push(combo);
      return combo === "inner"
        ? { models: ["openai/c"], override: { mode: "override", model: "openai/c", fallback: false } }
        : null;
    });
    const leaves = [];
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["inner", "openai/a"],
      handleSingleModel: async (_body, model) => model === "inner"
        ? handleComboChat({
            body: { messages: [{ role: "user", content: "hi" }] },
            models: ["openai/b", "openai/c"],
            handleSingleModel: async (_innerBody, leaf) => { leaves.push(leaf); return jsonResponse(); },
            log,
            comboName: "inner",
            comboStrategy: "round-robin",
            rawSession: "raw-session",
          })
        : jsonResponse(),
      log,
      comboName: "outer",
      comboStrategy: "round-robin",
      rawSession: "raw-session",
    });
    expect(calls).toEqual(["outer", "inner"]);
    expect(leaves).toEqual(["openai/c"]);
    expect(overrideMocks.loadOverrides).toHaveBeenCalledTimes(2);
  });

  it("leaves null, expired, denied, Codex-incompatible and thinker controls on normal routing", async () => {
    for (const result of [null, null, null, null, null]) {
      overrideMocks.resolveSessionOverride.mockReturnValueOnce(result);
    }
    const cases = [
      {},
      {}, // expired entries resolve to null in overrideStore
      { keyAccess: { _sets: { combos: new Set(), models: new Set() } } },
      { ua: "Codex/2.0" },
      { comboName: "thinker" },
    ];
    const orders = [];
    for (const options of cases) orders.push((await route(options)).tried);
    expect(orders).toEqual(cases.map(() => [normal[0]]));
  });

  it("passes current key access and user agent to resolution", async () => {
    const keyAccess = { _sets: { combos: new Set(["assistant"]), models: new Set() } };
    await route({ keyAccess, ua: "Codex/2.0" });
    expect(overrideMocks.resolveSessionOverride).toHaveBeenCalledWith(expect.objectContaining({
      keyAccess,
      ua: "Codex/2.0",
      comboMembers: normal,
      combo: "assistant",
    }));
  });
});
