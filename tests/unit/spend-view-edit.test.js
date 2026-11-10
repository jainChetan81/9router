import { describe, it, expect } from "vitest";
import { buildView } from "../../src/app/(dashboard)/dashboard/spend/view.js";

const G = { key: [], model: [], modelEffort: [], role: [], client: [], provider: [] };
const data = {
  totals: { subs: { claude: 10 }, list: 10, realDs30: 0 },
  bars: [{ label: "Nov 10", tick: "10", real: 0, v: 0, tot: 0 }], groups: G, fees: { claude: 20 }, subsMeta: [{ k: "claude", name: "Claude" }],
  range: { hourly: false, days: 30, first: "Oct 11", last: "Nov 10", to: 1 },
  loggedSince: null, allLogged: true, roleCount: {}, sessions: [], sessionCount: 0, sessionValue: 0,
  outliers: { real: [], value: [] }, topBars: [],
};
const view = (ui, feeSave) => buildView({
  data, quota: {}, ui: { group: "key", agView: "sessions", rank: "value", ...ui }, set: () => {},
  fit: { aW: 1060 }, range: { preset: "30D" }, feeRefs: {}, saveFees: () => {}, feeSave,
});

describe("spend view fee editing", () => {
  it("builds the edit view without throwing", () => {
    const v = view({ editing: true, draft: { claude: "20" } });
    expect(v.subs[0].feeErr).toBe("");
    expect(v.feesOk).toBe(true);
  });
  it("flags a negative fee", () => {
    const v = view({ editing: true, draft: { claude: "-5" } });
    expect(v.subs[0].feeErr).not.toBe("");
    expect(v.feesOk).toBe(false);
  });
  it("shows the save error message", () => {
    const v = view({ editing: true, draft: { claude: "20" } }, { state: "error", msg: "Save failed" });
    expect(v.feeError).toBe("Save failed");
  });
});
