import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

function response(ok, content = "ok") {
  const payload = ok
    ? { choices: [{ message: { role: "assistant", content } }] }
    : { error: { message: "member unavailable" } };
  return new Response(JSON.stringify(payload), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("re-pins a fallback without consuming an allocation and keeps stickyLimit behavior", async () => {
    const models = ["provider/model-a", "provider/model-b"];
    const invoke = async (sessionId, failA = false) => {
      const tried = [];
      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models,
        handleSingleModel: async (_body, model) => {
          tried.push(model);
          return response(!(failA && model === "provider/model-a"));
        },
        log: { info() {}, warn() {} },
        comboName: "sticky-limit",
        comboStrategy: "round-robin",
        comboStickyLimit: 2,
        sessionId,
        autoSwitch: false,
      });
      return tried;
    };

    expect(await invoke("s1", true)).toEqual(["provider/model-a", "provider/model-b"]);
    expect(await invoke("s2")).toEqual(["provider/model-a"]);
    expect(await invoke("s3")).toEqual(["provider/model-b"]);
    expect(await invoke("s1")).toEqual(["provider/model-b"]);
    expect(await invoke("s4")).toEqual(["provider/model-b"]);
    expect(await invoke("s5")).toEqual(["provider/model-a"]);
  });
});
