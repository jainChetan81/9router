import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { markFirstToken, register, snapshot, unregister } from "@/lib/agents/liveRegistry.js";
import { sessionKey } from "@/lib/agents/sessionKey.js";

const previousDataDir = process.env.DATA_DIR;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-live-registry-"));
process.env.DATA_DIR = tempDataDir;

afterAll(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

describe("agents live registry", () => {
  it("keeps only safe in-flight metadata and groups requests by session", () => {
    const reqId = `live-${crypto.randomUUID()}`;
    expect(register(reqId, {
      session: "0123456789ab",
      combo: "assistant",
      model: "openai/gpt-4o-mini",
      provider: "openai",
      apiKeyHash: "abcdef0123456789abcdef0123456789",
      apiKey: "secret-api-key",
      prompt: "private prompt text",
      startedAt: performance.now(),
    })).toBe(true);
    expect(markFirstToken(reqId)).toBe(true);

    const requests = snapshot()[sessionKey("0123456789ab")];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      reqId,
      combo: "assistant",
      model: "openai/gpt-4o-mini",
      apiKeyHash: "abcdef0123456789abcdef0123456789",
    });
    expect(requests[0].firstTokenAt).toEqual(expect.any(Number));
    expect(requests[0]).not.toHaveProperty("apiKey");
    expect(requests[0]).not.toHaveProperty("prompt");
    expect(unregister(reqId, "ok")).toBe(true);
    expect(snapshot()[sessionKey("0123456789ab")]).toBeUndefined();
  });

  it("fails open and evicts the oldest entry above the cap", () => {
    expect(register("invalid-session", { session: "", model: "x" })).toBe(false);
    expect(markFirstToken("missing")).toBe(false);
    const ids = Array.from({ length: 501 }, (_, index) => `cap-${index}`);
    for (const reqId of ids) {
      expect(register(reqId, { session: "abcdef012345", model: "openai/gpt-4o-mini" })).toBe(true);
    }
    const requests = snapshot()[sessionKey("abcdef012345")];
    expect(requests).toHaveLength(500);
    expect(requests.some((request) => request.reqId === "cap-0")).toBe(false);
    expect(requests.some((request) => request.reqId === "cap-500")).toBe(true);
    for (const reqId of ids) unregister(reqId);
  });

  it("canonicalizes raw request sessions before storing them", () => {
    const reqId = `raw-${crypto.randomUUID()}`;
    const rawSession = "claude:550e8400-e29b-41d4-a716-446655440000";
    expect(register(reqId, { session: rawSession, model: "openai/gpt-4o-mini" })).toBe(true);
    expect(snapshot()[sessionKey(rawSession)]).toHaveLength(1);
    unregister(reqId);
  });

  it("hashes a raw 12-hex identity instead of treating it as a dashboard key", () => {
    const reqId = "raw-abcdef123456";
    const rawSession = "abcdef123456";
    expect(register(reqId, { session: rawSession, model: "openai/gpt-4o-mini" })).toBe(true);
    expect(snapshot()[sessionKey(rawSession)]).toHaveLength(1);
    expect(snapshot()[rawSession]).toBeUndefined();
    unregister(reqId);
  });

  it("expires entries after the 10-minute TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
      const reqId = `ttl-${crypto.randomUUID()}`;
      const session = "ttl-session-1";
      expect(register(reqId, { session, model: "openai/gpt-4o-mini", startedAt: 100 })).toBe(true);

      vi.advanceTimersByTime(10 * 60 * 1000 - 1);
      expect(snapshot()[sessionKey(session)]).toHaveLength(1);

      vi.advanceTimersByTime(2);
      expect(snapshot()[sessionKey(session)]).toBeUndefined();
      expect(markFirstToken(reqId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts an explicit monotonic timestamp on markFirstToken and preserves the first value", () => {
    const reqId = `ttft-${crypto.randomUUID()}`;
    const session = "ttft-session-1";
    expect(register(reqId, { session, model: "openai/gpt-4o-mini", startedAt: 100 })).toBe(true);
    expect(markFirstToken(reqId, 245.5)).toBe(true);
    expect(markFirstToken(reqId, 999.9)).toBe(true);
    expect(snapshot()[sessionKey(session)][0].firstTokenAt).toBe(245.5);
    unregister(reqId);
  });
});
