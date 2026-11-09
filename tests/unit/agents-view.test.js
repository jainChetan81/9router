import { describe, it, expect } from "vitest";
import { buildView, chip } from "../../src/app/(dashboard)/dashboard/agents/view.js";

const NOW = Date.parse("2026-11-09T08:00:00Z");
const ui = (o = {}) => ({ tab: "live", mode: "ready", exp: {}, ...o });

const live = {
  sessions: [
    { session: "aaaaaaaaaaaa", client: "Claude Code", lastTs: "2026-11-09T07:59:00Z", reqPerMin: 4, tpsRecent: 80, p50TotalMs: 12000, successRate: 100,
      roles: [{ role: "main", model: "claude-opus-5-5", requests: 10 }, { role: "scout", model: "ocg/glm-5.3-flash", requests: 6 }, { role: "background", model: "claude-haiku-5-5", requests: 4 }] },
    { session: "bbbbbbbbbbbb", client: "T3 Code", lastTs: "2026-11-09T07:58:00Z", reqPerMin: 1, tpsRecent: null, p50TotalMs: null, successRate: 90,
      parent: { session: "aaaaaaaaaaaa", inferred: true }, roles: [{ role: "implementer", model: "gpt-6-luna", requests: 5 }] },
  ],
};

describe("agents view", () => {
  it("builds live KPIs and nests inferred children under the parent", () => {
    const v = buildView({ live, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui(), now: NOW });
    const byLabel = Object.fromEntries(v.live.kpis.map((k) => [k.label, k]));
    expect(byLabel["ACTIVE SESSIONS"].value).toBe("1");
    expect(byLabel["REQUESTS / MIN"].value).toBe("5.0");
    expect(byLabel["TOKENS / S"].value).toBe("80");
    expect(v.live.cards.map((c) => [c.id, c.isChild])).toEqual([["s·aaaaaaaaaaaa", false], ["s·bbbbbbbbbbbb", true]]);
    expect(v.live.cards[0].bgNote).toBe(true);
  });

  it("shows dashes, never zero, when latency is missing (old rows)", () => {
    const old = { sessions: [{ ...live.sessions[1], parent: null, tpsRecent: null, p50TotalMs: null }] };
    const v = buildView({ live: old, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui(), now: NOW });
    const byLabel = Object.fromEntries(v.live.kpis.map((k) => [k.label, k]));
    expect(byLabel["TOKENS / S"].value).toBe("—");
    expect(byLabel["LATENCY P50"].value).toBe("—");
  });

  it("handles an empty response without throwing", () => {
    const v = buildView({ live: { sessions: [] }, sessions: [], analytics: null, range: { preset: "24h" }, ui: ui({ tab: "sessions" }), now: NOW });
    expect(v.live.cards).toEqual([]);
    expect(v.isSessTab).toBe(true);
  });

  it("builds tool rows, role splits, top tools, and sampling notes", () => {
    const tools = { tools: [{ name: "Read", calls: 10, errors: 2, byRole: [{ role: "main", calls: 6, errors: 1 }, { role: "scout", calls: 4, errors: 1 }], topModel: { model: "gpt-4o", calls: 6 } }],
      topToolsByRole: [{ role: "main", tools: [{ name: "Read", calls: 6, errors: 1 }] }], sampled: { rows: 12, cap: 100 }, truncated: true };
    const args = { tools, range: { preset: "7D" }, ui: ui({ tab: "tools" }), now: NOW };
    const v = buildView(args);
    expect(v.tl.rows[0]).toMatchObject({ name: "Read", calls: 10, errors: 2, pct: "20.0%", topModel: "gpt-4o" });
    expect(v.tl.rows[0].split.map((r) => r.f)).toEqual([60, 40]);
    expect(v.tl.perRole[0].items[0]).toMatchObject({ name: "Read", w: "100%" });
    expect(v.tl.sampleNote).toMatch(/truncated/i);
    const filtered = buildView({ ...args, ui: ui({ tab: "tools", toolRole: "scout" }) });
    expect(filtered.tl.rows[0]).toMatchObject({ calls: 4, errors: 1, pct: "25.0%" });
    expect(filtered.tl.rows[0].split.map((r) => r.role)).toEqual(["scout"]);
    expect(buildView({ ...args, tools: { tools: [], topToolsByRole: [] } }).tl).toMatchObject({ hasData: false, emptyTitle: "Tool tracking started Nov 9, 2026" });
  });

  it("gives every role a chip style", () => {
    for (const r of ["main", "scout", "implementer", "reviewer", "thinker", "background", "direct"]) expect(chip(r)).toBeTruthy();
  });

  it("locks thinker and background rows and filters Codex Other models to OpenAI", () => {
    const codexLive = { sessions: [{ ...live.sessions[0], client: "Codex", roles: [...live.sessions[0].roles, { role: "thinker", model: "gpt-6-astra" }] }] };
    const v = buildView({ live: codexLive, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui({ drawer: "aaaaaaaaaaaa" }),
      combos: [{ name: "main", models: ["gpt-6-luna"] }], models: ["gpt-6-luna", "anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"], now: NOW });
    const rows = Object.fromEntries(v.dr.rows.map((r) => [r.role, r]));
    expect(rows.thinker.locked).toBe(true);
    expect(rows.background.locked).toBe(true);
    expect(rows.main.otherOpts.map((o) => o.v)).toEqual(["gpt-6-luna", "openai/gpt-6.1-sol"]);
  });

  it("warns on Opus or Fable and detects model and mode changes", () => {
    const v = buildView({ live, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui({ drawer: "aaaaaaaaaaaa" }),
      combos: [{ name: "main", models: ["claude-haiku-5-5", "claude-opus-5-5"] }],
      draft: { main: { sel: "claude-opus-5-5", mode: "override" } }, now: NOW });
    const row = v.dr.rows.find((r) => r.role === "main");
    expect(row.warn).toMatch(/cost much more/i);
    expect(v.dr.noChanges).toBe(false);
    expect(v.dr.changes[0]).toMatchObject({ role: "main", to: "claude-opus-5-5", mode: "override" });
  });

  it("enables Apply when only an override expiry changes", () => {
    const v = buildView({ live, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui({ drawer: "aaaaaaaaaaaa" }),
      combos: [{ name: "main", models: ["claude-opus-5-5"] }],
      overridesBySession: { aaaaaaaaaaaa: [{ combo: "main", model: "claude-opus-5-5", mode: "member", expiry: "1h", status: "active" }] },
      draft: { main: { expiry: "2h" } }, now: NOW });
    expect(v.dr.noChanges).toBe(false);
    expect(v.dr.changes).toEqual([expect.objectContaining({ role: "main", expiry: "2h" })]);
    expect(v.dr.applyStyle.opacity).toBe(1);
  });

  it("shows pending, active override, changed member, and effective card models", () => {
    const overridesBySession = { aaaaaaaaaaaa: [
      { combo: "main", model: "gpt-6-luna", mode: "override", status: "active" },
      { combo: "scout", model: "ocg/glm-5.3", mode: "member", status: "active" },
      { combo: "background", model: "gpt-6.1-sol", mode: "override", status: "pending" },
    ] };
    const v = buildView({ live, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui(), overridesBySession, now: NOW });
    const card = v.live.cards.find((c) => c.id === "s·aaaaaaaaaaaa");
    const rows = Object.fromEntries(card.rows.map((r) => [r.role, r]));
    expect(rows.main.model).toBe("gpt-6-luna");
    expect(rows.main.tag).toBe("override");
    expect(rows.scout.tag).toBe("Routing changed");
    expect(rows.background.tag).toBe("pending → sol");
    expect(card.hasOverride).toBe(true);
    expect(card.hasChanged).toBe(true);
    expect(card.hasPending).toBe(true);
  });
});
