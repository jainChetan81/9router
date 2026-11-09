import { describe, it, expect } from "vitest";
import { buildView, buildPromptFilterKey, buildPromptRequestKey, canLandOnPrompt, sessionForOpenPrompt, PAGE } from "../../src/app/(dashboard)/dashboard/pii-guard/view.js";

const ui = { tab: "findings", view: "value", q: "", fGroup: "", fAction: "", fClient: "", fModel: "", fSource: "", sel: {}, page: 0, leakPage: 0, testKind: "text", testText: "", imgSel: 0 };
const base = (over = {}) => ({
  health: { module: true, loaded: true }, config: { mode: "off", rules: {} },
  rules: [{ id: "pan", label: "PAN", group: "id" }, { id: "email", label: "Email", group: "contact" }],
  summary: { groups: [], trend: [] }, ...over,
});
const view = (data, u = ui) => buildView({ data, ui: u, set: () => {}, act: () => {}, range: { preset: "24h" }, fit: null, test: {}, events: [], samples: [] });

describe("pii-guard view", () => {
  it("says off only when every rule is off", () => {
    expect(view(base()).status.text).toMatch(/^Off/);
    expect(view(base({ config: { mode: "off", rules: { pan: "observe" } } })).status.text).not.toMatch(/^Off/);
  });
  it("warns when the event read was truncated", () => {
    expect(view(base({ summary: { groups: [], trend: [], truncated: true } })).problems.some((p) => /cut short/.test(p.title))).toBe(true);
  });
  it("pages values with unique, non-empty keys and skips the work on other tabs", () => {
    const g = (i) => ({ hash: `h${i}`, rule: i % 2 ? "pan" : "email", sources: ["user/text"], actions: ["redact"], action: "redact", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), turns: 1, ignored: false });
    const data = base({ summary: { groups: Array.from({ length: PAGE + 5 }, (_, i) => g(i)), trend: [] } });
    const first = view(data), second = view(data, { ...ui, page: 1 });
    expect(first.values).toHaveLength(PAGE);
    expect(second.values).toHaveLength(5);
    const keys = first.values.map((v) => v.key);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(first.nextValues).toBeTypeOf("function");
    expect(second.nextValues).toBeNull();
    expect(view(data, { ...ui, tab: "overview" }).values).toHaveLength(0);
  });
  it("cards share one unit, sum to Found, and leaks offer rule actions, not Block next time", () => {
    const now = new Date().toISOString();
    const g = (hash, rule, action, extra = {}) => ({ hash, rule, sources: ["assistant/thinking"], actions: [action], action, firstSeen: now, lastSeen: now, turns: 1, ignored: false, ...extra });
    const groups = [g("a", "pan", "redact"), g("b", "pan", "leaked", { leakedWhere: ["assistant/thinking"], preview: "AB•••••F" }), g("c", "email", "observe", { ignored: true })];
    const byAction = { all: { values: { redact: 1, leaked: 1, allowed: 1 }, requests: { redact: 1, leaked: 1, ignored: 1 } }, pan: { values: { redact: 1, leaked: 1 }, requests: {} }, email: { values: { allowed: 1 }, requests: {} } };
    const data = base({ groups: [{ id: "id", label: "Government IDs" }, { id: "contact", label: "Contact" }], summary: { groups, trend: [], unique24h: 3, byAction, requests: 2 } });
    const v = view(data, { ...ui, tab: "overview" });
    const vals = v.cards.map((c) => Number(c.value));
    expect(vals[0]).toBe(vals.slice(1).reduce((a, b) => a + b, 0));
    expect(v.leaks).toHaveLength(1);
    expect(v.leaks[0].preview).toBe("AB•••••F");
    expect(v.leaks[0].signed).toBe(true);
    expect(v.leaks[0].ruleBtns.map((b) => b.label)).toEqual(["Observe", "Redact", "Block"]);
    expect(v.leaks[0]).not.toHaveProperty("blockNext");
    expect(v.byGroup.map((x) => x.name)).toEqual(["Government IDs", "Contact"]);
    const allowedOnly = view(data, { ...ui, fAction: "allowed" });
    expect(allowedOnly.values.map((x) => x.hash)).toEqual(["c"]);
    expect(view(data).values.map((x) => x.hash)).not.toContain("c");
  });
});

describe("couldn't-redact review", () => {
  it("hides a dismissed value until it shows up somewhere new, and wording never says leaked", async () => {
    const { buildView } = await import("../../src/app/(dashboard)/dashboard/pii-guard/view.js");
    const g = (where) => ({ hash: "aaaaaaaaaaaa", rule: "pan", sources: ["assistant/thinking"], actions: ["leaked"], action: "redact", leakedWhere: where, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), turns: 1, ignored: false });
    const make = (where, dismissed) => buildView({ data: { config: { mode: "observe", rules: { pan: "redact" }, dismissed }, health: { module: true, loaded: true }, rules: [{ id: "pan", label: "PAN", group: "gov_id" }], groups: [{ id: "gov_id", label: "Government IDs" }], summary: { groups: [g(where)], byAction: {} } },
      ui: { tab: "overview", view: "value", q: "", sel: {}, page: 0, leakPage: 0 }, set: () => {}, act: () => {}, range: { preset: "24h" }, test: {}, events: [], samples: [] });
    const open = make(["assistant/thinking"], {});
    expect(open.leaks).toHaveLength(1);
    expect(open.leaks[0].tag).toBe("In the model's reasoning");
    expect(open.status.text).toMatch(/1 value to review/);
    expect(JSON.stringify(open.cards)).not.toMatch(/leak/i);
    expect(make(["assistant/thinking"], { aaaaaaaaaaaa: ["assistant/thinking"] }).leaks).toHaveLength(0);
    expect(make(["assistant/thinking", "key"], { aaaaaaaaaaaa: ["assistant/thinking"] }).leaks).toHaveLength(1);
  });
});

describe("prompt landing request keys", () => {
  it("keeps prompt rows and cursors scoped to the filter key", () => {
    const range = { preset: "7D" };
    const key = buildPromptFilterKey("pan", "session-a", range);
    expect(buildPromptFilterKey("pan", "session-a", { ...range })).toBe(key);
    expect(buildPromptFilterKey("pan", "session-b", range)).not.toBe(key);
    expect(buildPromptRequestKey(key, 50)).not.toBe(buildPromptRequestKey(key, null));
  });

  it("lands only on rows loaded for the current filter and cursor", () => {
    const key = buildPromptFilterKey("", "session-a", { preset: "24h" });
    const currentRequest = buildPromptRequestKey(key, null);
    const olderPageRequest = buildPromptRequestKey(key, 50);
    expect(canLandOnPrompt(currentRequest, currentRequest, false)).toBe(true);
    expect(canLandOnPrompt(currentRequest, currentRequest, true)).toBe(false);
    expect(canLandOnPrompt(currentRequest, olderPageRequest, false)).toBe(false);
    expect(canLandOnPrompt(currentRequest, buildPromptRequestKey("old-session", null), false)).toBe(false);
  });
});

describe("prompt session choice", () => {
  it("uses the clicked prompt's own session and rejects a missing session", () => {
    expect(sessionForOpenPrompt("row-1", "prompt-session", "finding-session")).toBe("prompt-session");
    expect(sessionForOpenPrompt("row-1", "", "finding-session")).toBeNull();
  });

  it("keeps the finding session fallback only when no prompt row is involved", () => {
    expect(sessionForOpenPrompt("", "", "finding-session")).toBe("finding-session");
  });
});
