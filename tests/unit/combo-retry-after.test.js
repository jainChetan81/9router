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
});
