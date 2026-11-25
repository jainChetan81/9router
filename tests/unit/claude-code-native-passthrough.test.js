import { describe, it, expect } from "vitest";
import { selectAnthropicBeta } from "open-sse/providers/shared.js";
import { DefaultExecutor, applyClientClaudeHeaders } from "open-sse/executors/default.js";

const CLIENT = {
  "user-agent": "claude-cli/2.1.330 (external, cli)",
  "x-app": "cli",
  "x-stainless-package-version": "0.128.0",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "interleaved-thinking-2025-05-14,effort-2025-11-24,inline-tools-2026-09-15",
  "x-claude-code-session-id": "sess-1",
  "authorization": "Bearer client-token",
};

describe("Claude Code native passthrough headers", () => {
  it("does not withhold heavy-agent betas from Fable", () => {
    expect(selectAnthropicBeta("claude-fable-5-2").split(",")).toContain("effort-2025-11-24");
  });

  it("replaces static identity headers with the client's own", () => {
    const h = applyClientClaudeHeaders({ "User-Agent": "claude-cli/2.1.322", "X-Stainless-Helper-Method": "stream", "Anthropic-Beta": "redact-thinking-2026-02-12", Authorization: "Bearer upstream" }, CLIENT);
    expect(h["user-agent"]).toBe(CLIENT["user-agent"]);
    expect(h["User-Agent"]).toBeUndefined();
    expect(h["X-Stainless-Helper-Method"]).toBeUndefined();
    expect(h["x-stainless-package-version"]).toBe("0.128.0");
    expect(h["anthropic-beta"].split(",")).toEqual(["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "effort-2025-11-24", "inline-tools-2026-09-15"]);
    expect(h.Authorization).toBe("Bearer upstream");
    expect(h.authorization).toBeUndefined();
  });

  it("buildHeaders forwards client headers only for claudeNative", () => {
    const ex = new DefaultExecutor("claude");
    const native = ex.buildHeaders({ apiKey: "sk-test", claudeNative: true, rawHeaders: CLIENT }, true, null, "claude-fable-5-2", {});
    expect(native["user-agent"]).toBe(CLIENT["user-agent"]);
    expect(native["anthropic-beta"]).not.toContain("redact-thinking");
    const other = ex.buildHeaders({ apiKey: "sk-test", rawHeaders: CLIENT }, true, null, "claude-fable-5-2", {});
    expect(other["User-Agent"]).toMatch(/claude-cli/);
    expect(other["Anthropic-Beta"]).toContain("effort-2025-11-24");
  });
});
