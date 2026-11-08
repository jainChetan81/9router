import { describe, it, expect } from "vitest";
import { normalizeThinkingConfig } from "../../open-sse/services/provider.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { extractThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("normalizeThinkingConfig", () => {
  it("keeps openai reasoning_effort on non-user turns", () => {
    const body = {
      messages: [{ role: "assistant", content: "ok" }],
      reasoning_effort: "xhigh",
      thinking: { type: "enabled" },
    };

    normalizeThinkingConfig(body);

    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.thinking).toBeUndefined();
  });

  it("captures thinking before removing it from a tool-result turn", () => {
    const body = {
      messages: [{ role: "tool", content: "result" }],
      thinking: { type: "enabled", budget_tokens: 24576 },
    };

    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-6-luna", body, true, null, "codex");

    expect(body.thinking).toBeUndefined();
    expect(translated.reasoning_effort).toBe("high");
  });

  it("recognizes every client effort shape before provider defaults are injected", () => {
    const requests = [
      { reasoning_effort: "high" },
      { reasoning: { effort: "high" } },
      { output_config: { effort: "high" } },
      { thinking: { type: "enabled", budget_tokens: 24576 } },
      { thinkingConfig: { thinkingLevel: "high" } },
    ];

    for (const request of requests) expect(extractThinking(request)).not.toBeNull();
  });
});
