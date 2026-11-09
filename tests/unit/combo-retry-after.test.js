import { afterEach, describe, it, expect, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {} };
const models = ["provider/a", "provider/b"];
const body = { messages: [{ role: "user", content: "hello" }] };
const NOW = Date.parse("2026-11-08T12:00:00.000Z");

function failure(retryAfter, header = null) {
  const headers = { "content-type": "application/json" };
  if (header !== null) headers["retry-after"] = header;
  return new Response(JSON.stringify({ error: { message: "member unavailable" }, retryAfter }), {
    status: 500,
    headers,
  });
}

async function invoke(responses) {
  return handleComboChat({
    body,
    models,
    handleSingleModel: async (_body, model) => responses[models.indexOf(model)],
    log,
    comboName: "retry-after",
    comboStrategy: "fallback",
    autoSwitch: false,
  });
}

describe("combo Retry-After propagation", () => {
  afterEach(() => vi.useRealTimers());

  it("chooses the earliest future value from delta-seconds and HTTP-date headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await invoke([
      failure(null, "120"),
      failure(null, new Date(NOW + 90_000).toUTCString()),
    ]);

    expect(result.status).toBe(500);
    expect(result.headers.get("retry-after")).toBe("90");
  });

  it("keeps the legacy JSON retryAfter timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await invoke([
      failure(new Date(NOW + 45_000).toISOString()),
      failure(null, "invalid"),
    ]);

    expect(result.headers.get("retry-after")).toBe("45");
  });

  it("ignores invalid and expired retry times", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await invoke([
      failure(null, "yesterday"),
      failure(new Date(NOW - 1000).toISOString()),
    ]);

    expect(result.headers.has("retry-after")).toBe(false);
  });

  it("ignores an out-of-range delta-seconds value instead of throwing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await invoke([
      failure(null, "99999999999999"),
      failure(null, "30"),
    ]);

    expect(result.status).toBe(500);
    expect(result.headers.get("retry-after")).toBe("30");
  });
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("combo status after empty output", () => {
  it("keeps a later real upstream status instead of a synthetic 502", async () => {
    const result = await invoke([
      json({ choices: [{ message: { content: "" }, finish_reason: "in_progress" }] }),
      json({ error: { message: "rate limited" } }, 429),
    ]);
    expect(result.status).toBe(429);
  });

  it("returns the request-scoped member response after empty output", async () => {
    const result = await handleComboChat({
      body,
      models: ["provider/a", "provider/b", "provider/c"],
      handleSingleModel: async (_b, model) => model === "provider/c"
        ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400, headers: { "content-type": "application/json" } })
        : json({ choices: [{ message: { content: "" }, finish_reason: "in_progress" }] }),
      log,
      comboName: "empty-only",
      comboStrategy: "fallback",
      autoSwitch: false,
    });
    expect(result.status).toBe(400);
  });
});

describe("combo JSON no-retry finishes", () => {
  it("returns a content-filter JSON response without trying another member", async () => {
    const calls = [];
    const result = await handleComboChat({
      body,
      models,
      handleSingleModel: async (_b, model) => {
        calls.push(model);
        return model === "provider/a"
          ? json({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] })
          : json({ choices: [{ message: { content: "fallback answer" }, finish_reason: "stop" }] });
      },
      log,
      comboName: "content-filter",
      comboStrategy: "fallback",
      autoSwitch: false,
    });
    expect(calls).toEqual(["provider/a"]);
    expect((await result.json()).choices[0].finish_reason).toBe("content_filter");
  });
});
