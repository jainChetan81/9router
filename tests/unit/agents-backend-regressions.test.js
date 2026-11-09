import { describe, expect, it } from "vitest";
import { statusSql } from "@/lib/agents/dbColumns.js";
import { inferParents } from "@/lib/agents/queries.js";

describe("Agents backend regressions", () => {
  it("normalizes success and ok status values in analytics SQL", () => {
    const sql = statusSql();
    expect(sql).toContain("'ok','success'");
    expect(sql).toContain("THEN 'ok'");
  });

  it("selects and retains the earliest-started guessed parent", () => {
    const sessions = [
      { session: "child0000001", _apiKey: "key", client: "OpenCode", firstTs: "2026-11-09T10:10:00Z", lastTs: "2026-11-09T10:20:00Z", roles: [{ role: "implementer" }] },
      { session: "later0000001", _apiKey: "key", client: "Claude Code", firstTs: "2026-11-09T10:00:00Z", lastTs: "2026-11-09T10:30:00Z", roles: [{ role: "main" }] },
      { session: "early0000001", _apiKey: "key", client: "Claude Code", firstTs: "2026-11-09T09:00:00Z", lastTs: "2026-11-09T10:30:00Z", roles: [{ role: "main" }] },
    ];
    const first = inferParents(sessions).get("child0000001");
    expect(first).toMatchObject({ session: "early0000001", inferred: true, parentGuessed: true });
    const refreshed = inferParents([sessions[0], sessions[1]]).get("child0000001");
    expect(refreshed).toEqual(first);
  });
});
