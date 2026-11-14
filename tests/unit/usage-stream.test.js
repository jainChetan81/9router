import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-stream-"));
process.env.DATA_DIR = tempDataDir;

let route;
let usageRepo;
let db;
const previousDataDir = process.env.DATA_DIR;

function openStream() {
  const controller = new AbortController();
  const request = new Request("http://localhost/api/usage/stream", {
    headers: { host: "localhost" },
    signal: controller.signal,
  });
  return { request, controller };
}

async function readEvent(reader) {
  const { value, done } = await reader.read();
  return { text: value ? new TextDecoder().decode(value) : "", done };
}

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  route = await import("@/app/api/usage/stream/route.js");
});

afterAll(async () => {
  process.env.DATA_DIR = previousDataDir;
});

describe("/api/usage/stream", () => {
  it("sends an immediate slim snapshot and never calls getUsageStats per event", async () => {
    const getUsageStatsSpy = vi.spyOn(usageRepo, "getUsageStats");

    const { request, controller } = openStream();
    const response = await route.GET(request);
    const reader = response.body.getReader();

    // First event arrives on connect.
    const first = await readEvent(reader);
    expect(first.text).toContain("data: ");
    const snapshot = JSON.parse(first.text.split("data: ")[1].split("\n")[0]);
    expect(snapshot).toHaveProperty("activeRequests");
    expect(snapshot).toHaveProperty("recentRequests");
    expect(snapshot).toHaveProperty("errorProvider");
    expect(snapshot).toHaveProperty("pending");

    // A completed request must NOT trigger a full getUsageStats recompute.
    const callsBefore = getUsageStatsSpy.mock.calls.length;
    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      status: "ok",
    });

    const second = await readEvent(reader);
    expect(second.text).toContain("data: ");
    const update = JSON.parse(second.text.split("data: ")[1].split("\n")[0]);
    // Slim payload only — no byProvider/byModel aggregates.
    expect(update.byProvider).toBeUndefined();
    expect(update.byModel).toBeUndefined();

    await new Promise((r) => setTimeout(r, 1200));
    expect(getUsageStatsSpy.mock.calls.length).toBe(callsBefore);
    controller.abort();
  });

  it("broadcasts the same shared payload string to multiple clients", async () => {
    const a = openStream();
    const b = openStream();
    const ra = (await route.GET(a.request)).body.getReader();
    const rb = (await route.GET(b.request)).body.getReader();

    await readEvent(ra);
    await readEvent(rb);

    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      status: "ok",
    });

    const ea = await readEvent(ra);
    const eb = await readEvent(rb);
    expect(ea.text).toBe(eb.text);

    a.controller.abort();
    b.controller.abort();
  });

  it("throttles broadcasts to at most one per second", async () => {
    const { request, controller } = openStream();
    const response = await route.GET(request);
    const reader = response.body.getReader();
    await readEvent(reader);

    // Three rapid completions land inside one second → at most one extra event.
    for (let i = 0; i < 3; i++) {
      await db.saveRequestUsage({
        timestamp: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4o-mini",
        tokens: { prompt_tokens: 2, completion_tokens: 2 },
        status: "ok",
      });
    }
    // Wait just past the 1s throttle window, not long enough for another broadcast.
    await new Promise((r) => setTimeout(r, 1100));
    const extra = await readEvent(reader);
    expect(extra.text).toContain("data: ");
    // Nothing further within the same second.
    const nothing = await Promise.race([
      readEvent(reader).then((r) => r.text),
      new Promise((r) => setTimeout(() => r("<timeout>"), 400)),
    ]);
    expect(nothing).toBe("<timeout>");
    controller.abort();
  });

  it("cleans up the client on abort", async () => {
    const { request, controller } = openStream();
    const response = await route.GET(request);
    const reader = response.body.getReader();
    const bgRead = reader.read().catch(() => null);
    controller.abort();
    await Promise.race([bgRead, new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
    await new Promise((r) => setTimeout(r, 10));
    expect(() => {
      db.saveRequestUsage({
        timestamp: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4o-mini",
        tokens: { prompt_tokens: 3, completion_tokens: 3 },
        status: "ok",
      });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 1100));
  });
});
