import { describe, it, expect, beforeEach } from "vitest";

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import {
  clearStickyComboSession,
  getStickyComboModel,
  setStickyComboModel,
} from "../../open-sse/services/systemoneRouter.js";

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const models = ["p/a", "p/b", "p/c"];

function response(ok) {
  const json = ok
    ? { choices: [{ message: { role: "assistant", content: "ok" } }] }
    : { error: { message: "down" } };
  const make = () => ({ ok, status: ok ? 200 : 500, headers: new Headers({ "content-type": "application/json" }), clone: make, json: async () => json });
  return make();
}

async function first(sessionId, failing = new Set(), sessionSticky = true) {
  const tried = [];
  await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel: async (_b, m) => { tried.push(m); return response(!failing.has(m)); },
    log,
    comboName: "rr",
    comboStrategy: "round-robin",
    sessionId,
    sessionSticky,
  });
  return tried;
}

describe("sticky round-robin combo", () => {
  beforeEach(() => resetComboRotation());

  it("rotates new sessions and keeps each session on its model", async () => {
    expect((await first("s1"))[0]).toBe("p/a");
    expect((await first("s2"))[0]).toBe("p/b");
    expect((await first("s1"))[0]).toBe("p/a");
    expect((await first("s2"))[0]).toBe("p/b");
    expect((await first("s3"))[0]).toBe("p/c");
  });

  it("re-pins a session after its model fails", async () => {
    await first("s1");
    expect(await first("s1", new Set(["p/a"]))).toEqual(["p/a", "p/b"]);
    expect((await first("s1"))[0]).toBe("p/b");
  });

  it("keeps the fallback pinned across interleaved sessions without advancing rotation", async () => {
    expect((await first("s1"))[0]).toBe("p/a");
    expect((await first("s2"))[0]).toBe("p/b");
    expect(await first("s1", new Set(["p/a"]))).toEqual(["p/a", "p/b"]);
    expect((await first("s1"))[0]).toBe("p/b");
    expect((await first("s3"))[0]).toBe("p/c");
  });

  it("re-pins a fallback after the selected member throws", async () => {
    await first("throws");
    const tried = [];
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/a") throw new Error("network failure");
        return response(true);
      },
      log,
      comboName: "rr",
      comboStrategy: "round-robin",
      sessionId: "throws",
    });
    expect(tried).toEqual(["p/a", "p/b"]);
    expect(getStickyComboModel("rr", "throws", models)).toBe("p/b");
  });

  it("clears a sticky mapping only when it still matches the failed model", () => {
    setStickyComboModel("rr", "concurrent", "p/a");
    setStickyComboModel("rr", "concurrent", "p/b");
    clearStickyComboSession("rr", "concurrent", "p/a");
    expect(getStickyComboModel("rr", "concurrent", models)).toBe("p/b");
  });

  it("keeps a newer fallback pin when another request exhausts its failover", async () => {
    const pendingA = [];
    let allRequestsEntered;
    let bRequests = 0;
    const bothRequestsEntered = new Promise((resolve) => { allRequestsEntered = resolve; });
    setStickyComboModel("rr", "concurrent-failover", "p/a");
    const run = () => handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel: async (_body, model) => {
        if (model === "p/a") {
          return new Promise((resolve) => {
            pendingA.push(resolve);
            if (pendingA.length === 2) allRequestsEntered();
          });
        }
        bRequests += 1;
        return response(bRequests === 1);
      },
      log,
      comboName: "rr",
      comboStrategy: "round-robin",
      sessionId: "concurrent-failover",
    });

    const earlier = run();
    const later = run();
    await bothRequestsEntered;
    expect(pendingA).toHaveLength(2);

    pendingA[0](response(false));
    expect((await earlier).ok).toBe(true);
    expect(getStickyComboModel("rr", "concurrent-failover", models)).toBe("p/b");

    pendingA[1](response(false));
    expect((await later).status).toBe(500);
    expect(getStickyComboModel("rr", "concurrent-failover", models)).toBe("p/b");
  });

  it("rotates per request without a session id or when disabled", async () => {
    expect((await first(null))[0]).toBe("p/a");
    expect((await first(null))[0]).toBe("p/b");
    expect((await first("s9", new Set(), false))[0]).toBe("p/c");
    expect((await first("s9", new Set(), false))[0]).toBe("p/a");
    expect(getStickyComboModel("rr", "s9", models)).toBeNull();
  });

  it("drops the pin when the pinned member returns empty JSON as the final candidate", async () => {
    setStickyComboModel("solo", "s-empty", "p/a");
    const empty = { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "in_progress" }] };
    const make = () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), clone: make, json: async () => empty });
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"],
      handleSingleModel: async () => make(),
      log,
      comboName: "solo",
      comboStrategy: "round-robin",
      sessionId: "s-empty",
      sessionSticky: true,
    });
    expect(getStickyComboModel("solo", "s-empty", ["p/a"])).toBeNull();
  });
});

