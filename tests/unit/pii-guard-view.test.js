import { describe, it, expect } from "vitest";
import { buildView, effectiveConfig, isRefreshingState, buildPromptFilterKey, buildPromptRequestKey, canLandOnPrompt, sessionForOpenPrompt, PAGE, sortSessions, findingMarkers, groupMessages, toolFormat, collapseDefault, PROSE_LINES } from "../../src/app/(dashboard)/dashboard/pii-guard/view.js";

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

describe("effectiveConfig and isRefreshingState", () => {
  it("applies pending optimistic ops over the saved config", () => {
    const saved = { mode: "observe", rules: { pan: "redact" }, ocr: { quality: "basic", mode: "observe" } };
    const out = effectiveConfig(saved, {
      "mode:global": { optimistic: { mode: "redact" } },
      "rule:email": { optimistic: { rules: { email: "block" } } },
      "rule:pan": { optimistic: { rules: { pan: "default" } } },
      "ocr:quality": { optimistic: { ocr: { quality: "enhanced" } } },
      "noop": { optimistic: null },
    });
    expect(out.mode).toBe("redact");
    expect(out.rules).toEqual({ email: "block" });
    expect(out.ocr).toEqual({ quality: "enhanced", mode: "observe" });
    expect(out.configKeyIfAny).toBeUndefined();
    expect(effectiveConfig(saved).rules).toEqual({ pan: "redact" });
    expect(effectiveConfig().mode).toBe("observe");
  });

  it("shows Updating… only for range, save, and manual loads with data present", () => {
    const withData = { hasData: true, mode: "loading", refreshReason: "range" };
    expect(isRefreshingState(withData)).toBe(true);
    expect(isRefreshingState({ hasData: true, mode: "ready", refreshReason: "manual" })).toBe(true);
    // Silent 30s poll and other reasons never show the indicator.
    expect(isRefreshingState({ hasData: true, mode: "loading", refreshReason: "poll" })).toBe(false);
    expect(isRefreshingState({ hasData: true, mode: "error", refreshReason: "manual" })).toBe(false);
    expect(isRefreshingState({ hasData: false, mode: "loading", refreshReason: "range" })).toBe(false);
  });
});

describe("session helpers", () => {
  const rows = [
    { sessionId: "s2", last: 200, first: 150, requests: 4, values: 2, client: "a" },
    { sessionId: "s1", last: 300, first: 100, requests: 1, values: 5, client: "b" },
    { sessionId: "s3", last: 100, first: 300, requests: 9, values: 1, client: "c" },
  ];
  it("sortSessions orders by the chosen key with last desc by default", () => {
    expect(sortSessions(rows).map((r) => r.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(sortSessions(rows, "first", false).map((r) => r.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(sortSessions(rows, "requests").map((r) => r.sessionId)).toEqual(["s3", "s2", "s1"]);
    expect(sortSessions(rows, "values", false).map((r) => r.sessionId)).toEqual(["s3", "s2", "s1"]);
    expect(sortSessions([], "values")).toEqual([]);
  });
  it("groupMessages orders request groups by first stored appearance and numbers them 1..n", () => {
    const rows = [
      { id: 1, ts: 100, requestId: "r2", role: "user", kind: "text", values: [] },
      { id: 2, ts: 110, requestId: "r2", role: "assistant", kind: "text", values: [] },
      { id: 3, ts: 120, requestId: "r1", role: "user", kind: "text", values: [] },
    ];
    const groups = groupMessages(rows);
    expect(groups.map((g) => g.requestId)).toEqual(["r2", "r1"]);
    expect(groups.map((g) => g.n)).toEqual([1, 2]);
    expect(groups[0].messages.map((m) => m.id)).toEqual([1, 2]);
    expect(rows.map((r) => r._index)).toEqual([0, 1, 2]); // one index across groups, shared with findingMarkers;
  });
  it("findingMarkers emits one marker per value per message in stored order", () => {
    const flat = [
      { id: 1, _index: 0, values: [] },
      { id: 2, _index: 1, values: ["h1", "h2"] },
      { id: 3, _index: 2, values: ["h3"] },
      { id: 4, _index: 3, values: ["h1", "h2"] },
    ];
    const markers = findingMarkers(flat);
    expect(markers.map((m) => [m.id, m.value])).toEqual([["2", "h1"], ["2", "h2"], ["3", "h3"], ["4", "h1"], ["4", "h2"]]);
    expect(markers.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(markers[1].n).toBe(2);
    expect(findingMarkers([{ id: 9, _index: 0, values: [] }])).toEqual([]);
  });
  it("toolFormat turns Bash into code, parsed args into fields, and falls back on garbage", () => {
    expect(toolFormat("Bash", 'Bash {"command":"npm test"}')).toEqual({ kind: "command", command: "npm test" });
    const fields = toolFormat("Write", 'Write {"file_path":"/tmp/a","content":"x"}');
    expect(fields.kind).toBe("fields");
    expect(fields.fields).toEqual([
      { key: "file_path", value: "/tmp/a" },
      { key: "content", value: "x" },
    ]);
    expect(toolFormat("Tool", "Tool [1,2")).toEqual({ kind: "text", text: "[1,2" });
    expect(toolFormat("Tool", "")).toEqual({ kind: "text", text: "Cannot format arguments" });
  });
  it("collapseDefault collapses tools, system messages, and prose beyond the line budget", () => {
    expect(collapseDefault("user", "tool_use", "")).toBe(true);
    expect(collapseDefault("system", "text", "")).toBe(true);
    expect(collapseDefault("assistant", "text", "one\ntwo\nthree")).toBe(false);
    expect(collapseDefault("assistant", "text", "1\n2\n3\n4\n5\n6\n7")).toBe(true);
    expect(PROSE_LINES).toBe(6);
  });
});
