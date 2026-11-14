import { describe, it, expect, vi, afterEach } from "vitest";
import { sanitizeDashboardSync, syncSecondsFor, syncLabel, SYNC_DEFAULTS, createCountdown } from "../../src/lib/dashboardSync.js";

describe("dashboardSync", () => {
  it("keeps known pages with allowed values", () => {
    expect(sanitizeDashboardSync({ agents: 30, spend: "0" })).toEqual({ agents: 30, spend: 0 });
  });
  it("rejects bad values, bad shapes and empty input", () => {
    expect(sanitizeDashboardSync({ agents: 7 })).toBeNull();
    expect(sanitizeDashboardSync({ agents: -1 })).toBeNull();
    expect(sanitizeDashboardSync([10])).toBeNull();
    expect(sanitizeDashboardSync("x")).toBeNull();
    expect(sanitizeDashboardSync({ other: 10 })).toBeNull();
  });
  it("drops unknown pages", () => {
    expect(sanitizeDashboardSync({ agents: 10, __proto__x: 10 })).toEqual({ agents: 10 });
  });
  it("falls back to defaults", () => {
    expect(syncSecondsFor({}, "agents")).toBe(SYNC_DEFAULTS.agents);
    expect(syncSecondsFor({ dashboardSync: { agents: 60 } }, "agents")).toBe(60);
    expect(syncSecondsFor({ dashboardSync: { agents: 7 } }, "agents")).toBe(SYNC_DEFAULTS.agents);
  });
  it("labels intervals", () => {
    expect(syncLabel(0)).toBe("Off");
    expect(syncLabel(30)).toBe("30 s");
    expect(syncLabel(300)).toBe("5 min");
  });
});

describe("auto-sync countdown", () => {
  // A hand-driven clock and tab: the countdown takes both as inputs.
  const setup = (seconds) => {
    vi.useFakeTimers();
    const state = { hidden: false, fired: 0, notified: 0 };
    const countdown = createCountdown({ onFire: () => { state.fired++; }, hidden: () => state.hidden });
    countdown.subscribe(() => { state.notified++; });
    countdown.setSeconds(seconds);
    return { countdown, state };
  };
  afterEach(() => { vi.useRealTimers(); });

  it("counts down once a second, fires at zero and starts over", () => {
    const { countdown, state } = setup(10);
    expect(countdown.getLeft()).toBe(10);
    vi.advanceTimersByTime(3000);
    expect(countdown.getLeft()).toBe(7);
    expect(state.fired).toBe(0);
    vi.advanceTimersByTime(7000);
    expect(state.fired).toBe(1);
    expect(countdown.getLeft()).toBe(10);
    countdown.stop();
  });

  it("tells only its subscribers, once per changed second", () => {
    const { countdown, state } = setup(10);
    const before = state.notified;
    vi.advanceTimersByTime(4000);
    expect(state.notified - before).toBe(4);
    countdown.stop();
  });

  it("runs no timer while the tab is hidden and syncs at once when a stale tab returns", () => {
    const { countdown, state } = setup(30);
    state.hidden = true; countdown.visibility();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(state.fired).toBe(0);
    state.hidden = false; countdown.visibility();
    expect(state.fired).toBe(1);
    expect(countdown.getLeft()).toBe(30);
    expect(vi.getTimerCount()).toBe(1);
    countdown.stop();
  });

  it("carries on without a sync when the tab returns before the deadline", () => {
    const { countdown, state } = setup(60);
    vi.advanceTimersByTime(10_000);
    state.hidden = true; countdown.visibility();
    vi.advanceTimersByTime(20_000);
    state.hidden = false; countdown.visibility();
    expect(state.fired).toBe(0);
    expect(countdown.getLeft()).toBe(30);
    countdown.stop();
  });

  it("a manual sync restarts the interval, and 0 turns it off", () => {
    const { countdown, state } = setup(10);
    vi.advanceTimersByTime(6000);
    countdown.restart();
    expect(countdown.getLeft()).toBe(10);
    countdown.setSeconds(0);
    expect(countdown.getLeft()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(state.fired).toBe(0);
  });
});

describe("defaults", () => {
  it("agents falls back to a 60 s timer: live data comes from the stream", () => {
    expect(SYNC_DEFAULTS).toEqual({ agents: 60, spend: 0, piiGuard: 0, quota: 0 });
  });
});
