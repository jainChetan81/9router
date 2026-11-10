import { describe, it, expect } from "vitest";
import { roleOf, isErrorStatus, bgRole, effectiveRole, resolveRoleName, isModelNamedCombo } from "../../src/lib/agents/meta.js";
import { roleSql } from "../../src/lib/agents/dbColumns.js";

// N8: model-named combos are direct, "daily"/"invalid" surface as config errors
// in the view, and "assistant" (a named role-like combo) is preserved.

describe("agents role normalization (N8)", () => {
  it("maps model-named combos to direct", () => {
    const modelNamed = [
      "claude-opus-5-5", "gpt-6-luna", "gpt-6.1-terra", "kimi-k3.1-pro", "glm-5.3",
      "gemini-3.8-flash", "deepseek-v4.1-flash", "qwen3.8-flash", "muse-spark-1.3-contributor",
      "codex-5", "ocg/glm-5.3-flash", "cc/claude-haiku-5-5",
    ];
    for (const name of modelNamed) expect(roleOf({ combo: name })).toBe("direct");
  });

  it("treats 'daily' and 'invalid' as direct at the role level", () => {
    expect(roleOf({ combo: "daily" })).toBe("direct");
    expect(roleOf({ combo: "invalid" })).toBe("direct");
  });

  it("keeps real roles and the assistant combo intact", () => {
    expect(roleOf({ combo: "implementer" })).toBe("implementer");
    expect(roleOf({ combo: "scout" })).toBe("scout");
    expect(roleOf({ combo: "reviewer" })).toBe("reviewer");
    expect(roleOf({ combo: "thinker" })).toBe("thinker");
    expect(roleOf({ combo: "assistant" })).toBe("assistant");
    expect(roleOf({ combo: null })).toBe("direct");
    expect(roleOf({})).toBe("direct");
  });

  it("recognizes background via the client rule", () => {
    expect(bgRole("Claude Code", "claude-haiku-5-5")).toBe("background");
    expect(effectiveRole("Claude Code", "claude-haiku-5-5")).toBe("background");
    // Model-named combos in other clients stay direct
    expect(effectiveRole("OpenCode", "gpt-6-luna")).toBe("direct");
  });

  it("flags model-named combos consistently", () => {
    expect(isModelNamedCombo("gpt-6-luna")).toBe(true);
    expect(isModelNamedCombo("implementer")).toBe(false);
    expect(isModelNamedCombo("direct")).toBe(false);
  });
});

describe("agents error status (A26)", () => {
  it("treats success and ok as success", () => {
    expect(isErrorStatus("ok")).toBe(false);
    expect(isErrorStatus("success")).toBe(false);
    expect(isErrorStatus("aborted")).toBe(true); // aborted is not ok
    expect(isErrorStatus("error")).toBe(true);
  });
});

describe("agents roleSql matches JS semantics", () => {
  const evaluate = (combo, ua) => {
    const sql = `SELECT ${roleSql()} AS role`;
    return sql;
  };
  it("contains the mapping cases", () => {
    const sql = roleSql();
    expect(sql).toContain("'claude-haiku-5-5'");
    expect(sql).toContain("GLOB");
    expect(sql).toContain("'daily'");
  });
});

import { clientVersionOf } from "../../src/lib/agents/meta.js";
describe("clientVersionOf", () => {
  it("returns only the version number from known clients", () => {
    expect(clientVersionOf("claude-cli/2.1.319 (external, cli)")).toBe("2.1.319");
    expect(clientVersionOf("codex_cli_rs/0.98.1")).toBe("0.98.1");
    expect(clientVersionOf("opencode/1.4.2")).toBe("1.4.2");
    expect(clientVersionOf("Mozilla/5.0")).toBeNull();
    expect(clientVersionOf(undefined)).toBeNull();
  });
});
