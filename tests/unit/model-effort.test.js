import { describe, expect, it, vi } from "vitest";
import { getFixedEffortLevel, getModelEffortKey, resolveModelEffortSetting } from "../../open-sse/services/modelEffort.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

describe("per-model effort resolution", () => {
  it("stores provider aliases under their canonical provider ID", () => {
    expect(getModelEffortKey("cx", "gpt-6-luna(high)")).toBe("codex/gpt-6-luna");
    expect(getModelEffortKey("cx", "gpt-6-luna-max")).toBe("codex/gpt-6-luna");
    expect(getModelEffortKey("codex", "gpt-6-luna")).toBe("codex/gpt-6-luna");
    expect(getModelEffortKey("kiro", "claude-sonnet-4-5")).toBe("kiro/claude-sonnet-4.5");
  });

  it("keeps registered model IDs that end in an effort word", () => {
    expect(getModelEffortKey("ag", "gemini-3.8-flash-high")).toBe("antigravity/gemini-3.8-flash-high");
  });

  it("normalizes a supported Codex hyphen suffix for downstream thinking selection", () => {
    expect(getModelUpstreamId("cx", "gpt-6-luna-max", { reasoning_effort: "low" })).toBe("gpt-6-luna(max)");
  });

  it("resolves max suffixes for models that do not support xhigh", () => {
    expect(getModelEffortKey("codebuddy-cn", "deepseek-v4.1-flash-max")).toBe("codebuddy-cn/deepseek-v4.1-flash");
  });

  it("resolves a saved model setting for a Codex hyphen effort suffix", () => {
    const overrides = { "codex/gpt-6-luna": { effort: "low" } };
    expect(resolveModelEffortSetting(overrides, "cx", "gpt-6-luna-max")).toEqual({ effort: "low", locked: false });
  });

  it("treats legacy entries without a lock field as saved defaults", () => {
    expect(resolveModelEffortSetting({ "codex/gpt-6-luna": { effort: "medium" } }, "codex", "gpt-6-luna"))
      .toEqual({ effort: "medium", locked: false });
  });

  it("preserves an explicit lock flag", () => {
    expect(resolveModelEffortSetting({ "codex/gpt-6-luna": { effort: "high", locked: true } }, "codex", "gpt-6-luna"))
      .toEqual({ effort: "high", locked: true });
  });

  it("resolves each target model independently for combo fallbacks", () => {
    const overrides = {
      "codex/gpt-6-luna": { effort: "high" },
      "openai/gpt-6-luna": { effort: "low" },
    };

    expect(resolveModelEffortSetting(overrides, "cx", "gpt-6-luna")).toEqual({ effort: "high", locked: false });
    expect(resolveModelEffortSetting(overrides, "openai", "gpt-6-luna")).toEqual({ effort: "low", locked: false });
    expect(resolveModelEffortSetting(overrides, "codex", "gpt-6-astra")).toBeNull();
  });

  it("ignores invalid persisted levels and reports valid choices", () => {
    const onInvalid = vi.fn();
    const effort = resolveModelEffortSetting({ "codex/gpt-6-luna": { effort: "ultra" } }, "codex", "gpt-6-luna", onInvalid);

    expect(effort).toBeNull();
    expect(onInvalid).toHaveBeenCalledWith(expect.objectContaining({
      key: "codex/gpt-6-luna",
      effort: "ultra",
      validChoices: expect.arrayContaining(["auto", "max"]),
    }));
  });

  it("identifies fixed tier models", () => {
    expect(getFixedEffortLevel("antigravity", "gemini-3.8-flash-high")).toBe("high");
    expect(getFixedEffortLevel("antigravity", "gemini-3.8-flash")).toBeNull();
  });

  it("reads explicit fixed effort for presets with bare upstream IDs", () => {
    expect(getFixedEffortLevel("grok-cli", "grok-4.5-low")).toBe("low");
    expect(getFixedEffortLevel("grok-cli", "grok-4.5-medium")).toBe("medium");
    expect(getFixedEffortLevel("grok-cli", "grok-4.5-high")).toBe("high");
    expect(getFixedEffortLevel("deepseek", "deepseek-v4-pro-max")).toBe("max");
    expect(getFixedEffortLevel("deepseek", "deepseek-v4-pro-none")).toBe("none");
    expect(getFixedEffortLevel("antigravity", "gemini-3.1-pro-high")).toBe("high");
  });

  it.each([
    ["antigravity", "gpt-oss-120b-medium", "medium"],
  ])("reports %s/%s as fixed at %s", (provider, model, effort) => {
    expect(getFixedEffortLevel(provider, model)).toBe(effort);
  });

  it("does not resolve saved settings for explicit fixed presets", () => {
    const onInvalid = vi.fn();
    const effort = resolveModelEffortSetting(
      { "deepseek/deepseek-v4-pro-none": { effort: "high" } },
      "deepseek",
      "deepseek-v4-pro-none",
      onInvalid,
    );

    expect(effort).toBeNull();
    expect(onInvalid).toHaveBeenCalledWith({
      key: "deepseek/deepseek-v4-pro-none",
      effort: "high",
      validChoices: ["auto"],
    });
  });
});
