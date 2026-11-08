import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("provider-specific thinking effort routing", () => {
  it("keeps Grok CLI client xhigh effort instead of rewriting it to high", () => {
    const body = { input: "hello", reasoning: { effort: "xhigh" } };
    const upstreamModel = getModelUpstreamId("gcli", "grok-4.5", body);

    applyThinking("openai-responses", upstreamModel, body, "grok-cli");

    expect(getThinkingLevels("grok-cli", "grok-4.5")).toContain("xhigh");
    expect(upstreamModel).toBe("grok-4.5");
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("keeps a locked Grok CLI xhigh setting", () => {
    const upstreamModel = getModelUpstreamId("gcli", "grok-4.5", {}, "xhigh");
    const body = { input: "hello" };

    applyThinking("openai-responses", upstreamModel, body, "grok-cli");

    expect(upstreamModel).toBe("grok-4.5(xhigh)");
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it.each(["none", "auto"])("keeps Grok CLI %s without remapping it to a tier", (effort) => {
    const body = { input: "hello", reasoning: { effort } };
    const upstreamModel = getModelUpstreamId("gcli", "grok-4.5", body);

    applyThinking("openai-responses", upstreamModel, body, "grok-cli");

    expect(upstreamModel).toBe("grok-4.5");
    if (effort === "none") {
      expect(body).not.toHaveProperty("reasoning");
      expect(body.reasoning_effort).toBe("none");
    } else {
      expect(body.reasoning_effort).toBe("auto");
    }
  });

  it("leaves non-tiered Codex and Claude models at their master routing IDs", () => {
    const codexEffort = { reasoning_effort: "max" };
    const claudeEffort = { output_config: { effort: "xhigh" } };

    expect(getThinkingLevels("codex", "gpt-6-luna")).toContain("max");
    expect(getThinkingLevels("claude", "claude-opus-5-5")).toContain("xhigh");
    expect(getModelUpstreamId("cx", "gpt-6-luna", codexEffort)).toBe("gpt-6-luna");
    expect(getModelUpstreamId("cc", "claude-opus-5-5", claudeEffort)).toBe("claude-opus-5-5");
  });

  it.each([
    ["deepseek", "deepseek-v4-pro", "low", "deepseek-v4-pro", "deepseek-v4-pro(low)"],
    ["ocz", "gpt-5.1-codex", "none", "gpt-5.1-codex", "gpt-5.1-codex(none)"],
    ["ag", "claude-opus-5-5", "auto", "claude-opus-5-5-high(auto)", "claude-opus-5-5-high(auto)"],
    ["cu", "claude-4.5-opus", "xhigh", "claude-4.5-opus-high", "claude-4.5-opus-high(xhigh)"],
  ])("matches the pre-PR oracle for %s/%s at %s", (provider, model, effort, clientExpected, overrideExpected) => {
    expect(getModelUpstreamId(provider, model, { reasoning_effort: effort })).toBe(clientExpected);
    expect(getModelUpstreamId(provider, model, {}, effort)).toBe(overrideExpected);
  });
});

describe("Qwen-style disabled thinking on implicit tiers", () => {
  it("routes enable_thinking false to the lowest Gemini 3.8 Flash preset", () => {
    expect(getModelUpstreamId("ag", "gemini-3.8-flash", { enable_thinking: false })).toBe("gemini-3.8-flash-low(low)");
  });

  it("leaves enable_thinking true on the implicit tier", () => {
    expect(getModelUpstreamId("ag", "gemini-3.8-flash", { enable_thinking: true })).toBe("gemini-3.8-flash-medium(medium)");
  });
});
