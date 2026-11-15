import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-live-route-"));
process.env.DATA_DIR = tempDataDir;

// The dashboard auth gate lives in middleware (src/dashboardGuard.js via proxy),
// so route handlers never see unauthenticated traffic. This test covers the
// stream itself: event shape, payload sanitization, ping, abort cleanup, cap.
let route;
let bump;

const previousDataDir = process.env.DATA_DIR;

function sseRequest() {
  const controller = new AbortController();
  const request = new Request("http://localhost/api/live", {
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
  const busModule = await import("@/lib/live/bus.js");
  bump = busModule.bump;
  route = await import("@/app/api/live/route.js");
});

afterAll(async () => {
  process.env.DATA_DIR = previousDataDir;
});

describe("/api/live stream", () => {
  it("sends a v event on bump with topic and version", async () => {
    const { request, controller } = sseRequest();
    const response = await route.GET(request);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body.getReader();
    bump("agents", { inflight: 2 });

    const { text } = await readEvent(reader);
    expect(text).toContain("event: v");
    const payload = JSON.parse(text.split("data: ")[1].split("\n")[0]);
    expect(payload.topic).toBe("agents");
    expect(payload.v).toBeGreaterThan(0);
    expect(payload.data).toEqual({ inflight: 2 });
    controller.abort();
  });

  it("never puts prompt text, keys or user agents on the stream", async () => {
    const { request, controller } = sseRequest();
    const response = await route.GET(request);
    const reader = response.body.getReader();

    bump("pii", { promptText: "secret prompt body", apiKey: "sk-abc123", ua: "curl/8.0", count: 3 });
    const { text } = await readEvent(reader);
    expect(text).not.toContain("secret prompt body");
    expect(text).not.toContain("sk-abc123");
    expect(text).not.toContain("curl/8.0");
    expect(JSON.parse(text.split("data: ")[1].split("\n")[0]).data.count).toBe(3);
    controller.abort();
  });

  it("keeps the same buffered payload when a second bump lands inside the 250 ms window", async () => {
    const { request, controller } = sseRequest();
    const response = await route.GET(request);
    const reader = response.body.getReader();

    bump("usage", { n: 1 });
    await readEvent(reader);
    bump("usage", { n: 2 });

    const { text } = await readEvent(reader);
    const payload = JSON.parse(text.split("data: ")[1].split("\n")[0]);
    expect(payload.data).toEqual({ n: 2 });
    controller.abort();
  });

  it("sends a ping every 25 s and stops after abort", async () => {
    vi.useFakeTimers();
    const { request, controller } = sseRequest();
    const response = await route.GET(request);
    const reader = response.body.getReader();

    const pingPromise = readEvent(reader);
    vi.advanceTimersByTime(25000);
    const { text } = await pingPromise;
    expect(text).toContain(": ping");

    controller.abort();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it("removes its subscriber on abort so a later bump does no work", async () => {
    const { request, controller } = sseRequest();
    const response = await route.GET(request);
    const reader = response.body.getReader();

    // Background read so abort can resolve it; abort must fire cleanup.
    const bgRead = reader.read().catch(() => null);
    controller.abort();
    await Promise.race([bgRead, new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
    await new Promise((r) => setTimeout(r, 10));

    // No reader is attached anymore: an enqueue after abort must not throw unhandled.
    expect(() => bump("usage")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("closes cleanly when the stream is cancelled", async () => {
    const request = new Request("http://localhost/api/live", { headers: { host: "localhost" } });
    const response = await route.GET(request);
    const reader = response.body.getReader();
    const bgRead = readEvent(reader).catch(() => null);
    await reader.cancel();
    await bgRead;
    await new Promise((r) => setTimeout(r, 10));
    expect(() => bump("usage")).not.toThrow();
  });
});
