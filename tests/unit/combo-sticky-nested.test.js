import { describe, it, expect, beforeEach } from "vitest";

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { getStickyComboModel } from "../../open-sse/services/systemoneRouter.js";

const log = { info() {}, warn() {} };

function jsonResponse(ok, content = "served") {
  const payload = ok
    ? { choices: [{ message: { role: "assistant", content } }] }
    : { error: { message: "member unavailable" } };
  return new Response(JSON.stringify(payload), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

describe("sticky nested combos", () => {
  beforeEach(() => resetComboRotation());

  it("pins the nested combo name outside and its serving leaf inside", async () => {
    const sessionId = "nested-session";
    const outerModels = ["inner-combo", "provider/direct"];
    const innerModels = ["provider/inner-a", "provider/inner-b"];
    const innerTried = [];

    const outerResponse = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: outerModels,
      handleSingleModel: async (_body, model) => {
        if (model !== "inner-combo") return jsonResponse(true);
        return handleComboChat({
          body: { messages: [{ role: "user", content: "hello" }] },
          models: innerModels,
          handleSingleModel: async (_innerBody, innerModel) => {
            innerTried.push(innerModel);
            return jsonResponse(innerModel !== innerModels[0]);
          },
          log,
          comboName: "inner-combo",
          comboStrategy: "round-robin",
          sessionId,
          autoSwitch: false,
        });
      },
      log,
      comboName: "outer-combo",
      comboStrategy: "round-robin",
      sessionId,
      autoSwitch: false,
    });

    expect(outerResponse.ok).toBe(true);
    expect(innerTried).toEqual(innerModels);
    expect(getStickyComboModel("outer-combo", sessionId, outerModels)).toBe("inner-combo");
    expect(getStickyComboModel("inner-combo", sessionId, innerModels)).toBe("provider/inner-b");
  });
});
