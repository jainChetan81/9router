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

describe("agents view fixes", () => {
  const sess = (id, lastTs, model = "claude-opus-5-5") => ({ session: id, client: "Claude Code", firstTs: lastTs, lastTs, requests: 1, tokens: 1, value: 0, errors: 0, roles: [{ role: "main", model, requests: 1, models: [] }] });
  const sessions = [sess("aaaaaaaaaaaa", "2026-11-09T07:59:00Z"), sess("bbbbbbbbbbbb", "2026-11-09T07:50:00Z")];

  it("keeps the selected session and does not jump to the top row (A15)", () => {
    const v = buildView({ live: null, sessions, totalSessions: 2, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", sel: "bbbbbbbbbbbb" }), now: NOW });
    expect(v.tree.rows.find((r) => r.isSess && r.sid === "bbbbbbbbbbbb").style.background).toBe("var(--acc2)");
  });
  it("shows the no-selection state when nothing is selected", () => {
    const v = buildView({ live: null, sessions, totalSessions: 2, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", sel: null }), now: NOW });
    expect(v.g).toBe(null);
    expect(v.noSelText).toBe("Select a session to see its timeline.");
  });
  it("shows 'N of TOTAL' when filters reduce the list (A14)", () => {
    const v = buildView({ live: null, sessions, totalSessions: 1748, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", q: "zzzz" }), now: NOW });
    expect(v.tree.count).toBe("0 of 1748");
    const all = buildView({ live: null, sessions, totalSessions: 1748, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions" }), now: NOW });
    expect(all.tree.count).toBe("1748 in range");
  });
  it("uses the 4-column session row grid (A12)", () => {
    const v = buildView({ live: null, sessions, totalSessions: 2, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions" }), now: NOW });
    expect(v.tree.rows[0].style.gridTemplateColumns).toBe("16px minmax(0,1fr) 8px auto");
  });
  it("offers Load more only when the API has a next cursor (A23)", () => {
    const v = buildView({ live: null, sessions, totalSessions: 1748, moreCursor: "abc", analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions" }), now: NOW });
    expect(v.tree.canMore).toBe(true);
    const none = buildView({ live: null, sessions, totalSessions: 2, moreCursor: null, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions" }), now: NOW });
    expect(none.tree.canMore).toBe(false);
  });
  it("shows no cost warning or Apply when the target equals the current model (A6, A7)", () => {
    const live2 = { sessions: [{ session: "aaaaaaaaaaaa", client: "Claude Code", lastTs: "2026-11-09T07:59:00Z", reqPerMin: 1, roles: [{ role: "implementer", model: "cc/claude-opus-5-5", requests: 5 }] }] };
    const models = [{ provider: "cc", model: "claude-opus-5-5", fullModel: "cc/claude-opus-5-5" }];
    const combos = [{ name: "implementer", models: ["claude-opus-5-5"] }];
    const v = buildView({ live: live2, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui({ drawer: "aaaaaaaaaaaa" }), now: NOW, combos, models, overrides: [] });
    const row = v.dr.rows[0];
    expect(row.warn).toBe("");
    expect(v.dr.noChanges).toBe(true);
    expect(v.dr.applyStyle.opacity).toBe(0.45);
  });
  it("filters non-chat models out of 'Other model…' (A8)", () => {
    const live2 = { sessions: [{ session: "aaaaaaaaaaaa", client: "Claude Code", lastTs: "2026-11-09T07:59:00Z", reqPerMin: 1, roles: [{ role: "implementer", model: "claude-opus-5-5", requests: 5 }] }] };
    const models = [
      { provider: "ocg", model: "glm-5.3-flash", fullModel: "ocg/glm-5.3-flash" },
      { provider: "ollama-local-tts-voices", model: "voice-a", fullModel: "ollama-local-tts-voices/voice-a" },
      { provider: "assemblyai", model: "universal", fullModel: "assemblyai/universal" },
      { provider: "black-forest-labs", model: "flux-pro", fullModel: "black-forest-labs/flux-pro" },
    ];
    const v = buildView({ live: live2, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui({ drawer: "aaaaaaaaaaaa" }), now: NOW, combos: [{ name: "implementer", models: ["claude-opus-5-5"] }], models, overrides: [] });
    const ids = v.dr.rows[0].otherGroups.flatMap((g) => g.opts.map((o) => o.v));
    expect(ids).toContain("ocg/glm-5.3-flash");
    expect(ids.some((id) => /voice|assemblyai|flux/.test(id))).toBe(false);
  });
  it("marks the expensive-model warning only for a changed target (A7)", () => {
    const live2 = { sessions: [{ session: "aaaaaaaaaaaa", client: "Claude Code", lastTs: "2026-11-09T07:59:00Z", reqPerMin: 1, roles: [{ role: "implementer", model: "glm-5.3-flash", requests: 5 }] }] };
    const models = [{ provider: "cc", model: "claude-opus-5-5", fullModel: "cc/claude-opus-5-5" }];
    const combos = [{ name: "implementer", models: ["glm-5.3-flash", "claude-opus-5-5"] }];
    const draft = { implementer: { sel: "claude-opus-5-5" } };
    const v = buildView({ live: live2, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui({ drawer: "aaaaaaaaaaaa" }), now: NOW, combos, models, overrides: [], draft });
    expect(v.dr.rows[0].warn).toContain("cost much more");
    expect(v.dr.changes[0].warn).toBe(true);
  });
  it("uses a 8 px minimum hit area for timeline bars (A20)", () => {
    const det = { session: "aaaaaaaaaaaa", client: "Claude Code", firstTs: "2026-11-09T07:00:00Z", lastTs: "2026-11-09T07:59:00Z",
      agents: [{ role: "main", requests: [{ ts: "2026-11-09T07:10:00Z", totalMs: 1, model: "claude-opus-5-5", status: "ok" }] }] };
    const v = buildView({ live: null, sessions, detail: det, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", sel: "aaaaaaaaaaaa" }), now: NOW });
    expect(v.g.lanes[0].bars[0].style.minWidth).toBe(8);
  });

  it("clamps the 6h window end to now and labels Day ranges with dates (A18, A33)", () => {
    const det = { session: "aaaaaaaaaaaa", client: "Claude Code", firstTs: "2026-11-09T07:00:00Z", lastTs: "2026-11-09T07:30:00Z",
      agents: [{ role: "main", requests: [{ ts: "2026-11-09T07:10:00Z", totalMs: 1000, model: "claude-opus-5-5", status: "ok" }] }] };
    const v = buildView({ live: null, sessions, detail: det, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", sel: "aaaaaaaaaaaa", zoom: "6h" }), now: NOW });
    expect(v.g.window).toMatch(/IST · 6h view/);
    const day = buildView({ live: null, sessions, detail: det, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", sel: "aaaaaaaaaaaa", zoom: "Day" }), now: NOW });
    // Day view is 24 h ending at now (13:30 IST), so it starts on Nov 8.
    expect(day.g.window).toMatch(/^Nov 8 13:30 – Nov 9 13:30 IST · Day view$/);
  });

  it("drops the detail when its session is filtered out (A16)", () => {
    const det = { session: "aaaaaaaaaaaa", client: "Claude Code", firstTs: "2026-11-09T07:00:00Z", lastTs: "2026-11-09T07:30:00Z",
      agents: [{ role: "main", requests: [{ ts: "2026-11-09T07:10:00Z", totalMs: 1000, model: "claude-opus-5-5", status: "ok" }] }] };
    const v = buildView({ live: null, sessions, detail: det, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", sel: "aaaaaaaaaaaa", q: "bbbb" }), now: NOW });
    expect(v.g).toBe(null);
  });
});

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

  it("exposes page-state flags under v.v so the Sessions tab renders", () => {
    const sessions = [{ session: "aaaaaaaaaaaa", client: "Claude Code", firstTs: "2026-11-09T07:00:00Z", lastTs: "2026-11-09T07:59:00Z", requests: 3, tokens: 10, value: 0, errors: 0, roles: [{ role: "main", models: [{ model: "claude-opus-5-5", requests: 3, tokens: 10, value: 0 }] }], parent: null }];
    for (const mode of ["ready", "stale"]) {
      const v = buildView({ live, sessions, totalSessions: 1, analytics: null, range: { preset: "7D" }, ui: ui({ tab: "sessions", mode }), now: NOW });
      expect(v.v.sess).toBe(true);
      expect(v.v.empty).toBe(false);
      expect(v.tree.rows.length).toBeGreaterThan(0);
    }
  });

  it("reads the live successRate as a 0-1 fraction", () => {
    const frac = { sessions: [{ ...live.sessions[0], successRate: 1 }, { ...live.sessions[1], parent: null, successRate: 0.9 }] };
    const v = buildView({ live: frac, sessions: [], analytics: null, range: { preset: "7D" }, ui: ui(), now: NOW });
    const byLabel = Object.fromEntries(v.live.kpis.map((k) => [k.label, k]));
    expect(v.live.cards[0].rows[0].succ).toBe("100%");
    expect(v.live.cards[1].rows[0].succ).toBe("90.0%");
    expect(byLabel["SUCCESS RATE"].value).not.toBe("1.0%");
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
    // The current model is already claude-opus-5-5, so the cost warning stays hidden (A7).
    expect(row.warn).toBe("");
    expect(v.dr.noChanges).toBe(false);
    expect(v.dr.changes[0]).toMatchObject({ role: "main", to: "claude-opus-5-5", mode: "override", warn: false });
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
