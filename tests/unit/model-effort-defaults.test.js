import { describe, expect, it } from "vitest";
import { resolveProviderDefaultEffort } from "../../open-sse/services/modelEffortDefaults.js";

describe("provider default effort resolution", () => {
  it("projects provider thinking levels through the shared normalizer", () => {
    expect(resolveProviderDefaultEffort({
      provider: "openai-compatible-chat-test",
      model: "gpt-6-luna",
      providerThinking: { mode: "high" },
      targetFormat: "openai",
    })).toBe("high");
  });

  it("converts provider thinking on to its 10000-token budget level", () => {
    expect(resolveProviderDefaultEffort({
      provider: "openai-compatible-chat-test",
      model: "gpt-6-luna",
      providerThinking: { mode: "on" },
      targetFormat: "openai",
    })).toBe("medium");
  });

  it("converts provider thinking off to none", () => {
    expect(resolveProviderDefaultEffort({
      provider: "openai-compatible-chat-test",
      model: "gpt-6-luna",
      providerThinking: { mode: "off" },
      targetFormat: "openai",
    })).toBe("none");
  });

  it("reports Codex Responses Lite medium and regular low defaults", () => {
    expect(resolveProviderDefaultEffort({ provider: "cx", model: "gpt-6-luna", targetFormat: "openai-responses" })).toBe("medium");
    expect(resolveProviderDefaultEffort({ provider: "codex", model: "gpt-6-astra", targetFormat: "openai-responses" })).toBe("low");
  });

  it("uses the current Lite route when the caller supplies it", () => {
    expect(resolveProviderDefaultEffort({
      provider: "codex",
      model: "gpt-6-luna",
      targetFormat: "openai-responses",
      responsesLite: false,
    })).toBe("low");
  });

  it("leaves OpenAI-compatible defaults to the upstream when no provider setting exists", () => {
    expect(resolveProviderDefaultEffort({
      provider: "openai-compatible-chat-test",
      model: "gpt-6-luna",
      targetFormat: "openai",
    })).toBeNull();
  });
});
