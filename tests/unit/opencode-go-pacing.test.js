import { describe, expect, it, vi } from "vitest";

import { createGoPacing } from "../../open-sse/services/opencodeGoPacing.js";

const DAY = 24 * 60 * 60 * 1000;
// Wednesday 2026-11-18 12:00 UTC: 2.5 days into the week (35.7%), day 15 of 30 for the month.
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const MONTH_RESET = new Date(NOW + 15 * DAY).toISOString();

function usage({ rolling = 10, weekly = 10, monthly = 10 } = {}) {
  return {
    quotas: {
      Rolling: { used: rolling, resetAt: null },
      Weekly: { used: weekly, resetAt: null },
      Monthly: { used: monthly, resetAt: MONTH_RESET },
    },
  };
}

function make(overrides = {}, fetchImpl) {
  const fetchUsage = fetchImpl || vi.fn(async () => usage());
  let t = NOW;
  const pacing = createGoPacing({
    fetchUsage,
    getKey: async () => "key",
    now: () => t,
    enabled: () => true,
    slackPct: () => 5,
    ...overrides,
  });
  return { pacing, fetchUsage, advance: (ms) => { t += ms; } };
}

describe("opencode-go pacing", () => {
  it("skips when monthly usage is ahead of pace", async () => {
    const { pacing } = make({}, vi.fn(async () => usage({ monthly: 60 })));
    expect(await pacing.shouldSkip()).toBe(true);
  });

  it("skips when weekly usage is ahead of pace", async () => {
    const { pacing } = make({}, vi.fn(async () => usage({ weekly: 50 })));
    expect(await pacing.shouldSkip()).toBe(true);
  });

  it("skips when the rolling window is at 95%", async () => {
    const { pacing } = make({}, vi.fn(async () => usage({ rolling: 95 })));
    expect(await pacing.shouldSkip()).toBe(true);
  });

  it("uses the member when behind pace", async () => {
    const { pacing } = make({}, vi.fn(async () => usage({ rolling: 50, weekly: 30, monthly: 50 })));
    expect(await pacing.shouldSkip()).toBe(false);
  });

  it("uses the member when the fetch throws", async () => {
    const { pacing } = make({}, vi.fn(async () => { throw new Error("boom"); }));
    expect(await pacing.shouldSkip()).toBe(false);
  });

  it("uses the member when the fetch returns no quotas", async () => {
    const { pacing } = make({}, vi.fn(async () => ({ message: "auth failed" })));
    expect(await pacing.shouldSkip()).toBe(false);
  });

  it("uses the member when no key is available", async () => {
    const { pacing, fetchUsage } = make({ getKey: async () => null });
    expect(await pacing.shouldSkip()).toBe(false);
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("caches the snapshot for 10 minutes then refetches", async () => {
    const { pacing, fetchUsage, advance } = make();
    await pacing.shouldSkip();
    advance(9 * 60 * 1000);
    await pacing.shouldSkip();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    advance(2 * 60 * 1000);
    await pacing.shouldSkip();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch across concurrent callers", async () => {
    const fetchUsage = vi.fn(() => new Promise((r) => setTimeout(() => r(usage({ monthly: 60 })), 20)));
    const { pacing } = make({}, fetchUsage);
    const results = await Promise.all([pacing.shouldSkip(), pacing.shouldSkip(), pacing.shouldSkip()]);
    expect(results).toEqual([true, true, true]);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it("never skips when the toggle is off", async () => {
    const { pacing, fetchUsage } = make({ enabled: () => false }, vi.fn(async () => usage({ monthly: 99 })));
    expect(await pacing.shouldSkip()).toBe(false);
    expect(fetchUsage).not.toHaveBeenCalled();
  });
});
