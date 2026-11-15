// Refetch policy of the Agents page: pause, tab gating, throttle, freshness.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS_SYNC_FALLBACK_S, LIVE_THROTTLE_MS, OVERRIDES_GAP_MS, agentsSyncSeconds, autoAllowed, createRefetcher, createTrailingPoller,
  freshnessOf, istClock, liveAutoAllowed, rangeNeeds,
} from "../../src/app/(dashboard)/dashboard/agents/liveSync.js";
import { SYNC_CHOICES } from "../../src/lib/dashboardSync.js";

describe("agents refetch policy", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  // The page's wiring in miniature: live topic changes call request(), the
  // fallback timer calls request(), "Sync now" calls force().
  function page(initial = {}) {
    const view = { paused: false, hidden: false, tab: "live", ...initial };
    const fetchLive = vi.fn();
    const live = createRefetcher({ run: fetchLive, throttleMs: LIVE_THROTTLE_MS, allowed: () => liveAutoAllowed(view) });
    return { view, fetchLive, live };
  }

  it("Pause stops every automatic fetch and Resume starts them again", () => {
    const { view, fetchLive, live } = page();
    expect(live.request()).toBe(true);
    expect(fetchLive).toHaveBeenCalledTimes(1);

    view.paused = true;
    for (let i = 0; i < 20; i++) { // 20 live-topic bumps and timer ticks over a minute
      expect(live.request()).toBe(false);
      vi.advanceTimersByTime(3000);
    }
    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(live.pending()).toBe(false);

    view.paused = false;
    expect(live.request()).toBe(true);
    expect(fetchLive).toHaveBeenCalledTimes(2);
  });

  it("a fetch queued by the throttle is dropped when Pause is pressed before it fires", () => {
    const { view, fetchLive, live } = page();
    live.request();
    live.request(); // inside the 2 s window: queued
    expect(live.pending()).toBe(true);
    view.paused = true;
    vi.advanceTimersByTime(LIVE_THROTTLE_MS * 2);
    expect(fetchLive).toHaveBeenCalledTimes(1);
  });

  it("Sync now still fetches while paused", () => {
    const { fetchLive, live } = page({ paused: true });
    live.force();
    expect(fetchLive).toHaveBeenCalledTimes(1);
  });

  it("throttles a burst of live changes to one fetch per 2 s", () => {
    const { fetchLive, live } = page();
    for (let i = 0; i < 50; i++) { live.request(); vi.advanceTimersByTime(100); } // 5 s of bumps
    vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    expect(fetchLive.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetchLive.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("fetches /live automatically only on the Live tab of a visible page", () => {
    expect(liveAutoAllowed({ paused: false, hidden: false, tab: "live" })).toBe(true);
    for (const tab of ["sessions", "roles", "tools"]) expect(liveAutoAllowed({ paused: false, hidden: false, tab })).toBe(false);
    expect(liveAutoAllowed({ paused: false, hidden: true, tab: "live" })).toBe(false);
    expect(liveAutoAllowed({ paused: true, hidden: false, tab: "live" })).toBe(false);
    expect(autoAllowed({ paused: false, hidden: false })).toBe(true);
    expect(autoAllowed({ paused: true, hidden: false })).toBe(false);
    expect(autoAllowed({ paused: false, hidden: true })).toBe(false);
  });

  it("loads analytics and tools only for their own tab", () => {
    expect(rangeNeeds({ tab: "live", drawer: null })).toEqual({ sessions: false, analytics: false, tools: false });
    expect(rangeNeeds({ tab: "sessions", drawer: null })).toEqual({ sessions: true, analytics: false, tools: false });
    expect(rangeNeeds({ tab: "roles", drawer: null })).toEqual({ sessions: false, analytics: true, tools: false });
    expect(rangeNeeds({ tab: "tools", drawer: null })).toEqual({ sessions: false, analytics: false, tools: true });
    // The details drawer shows session totals, also when opened from Live.
    expect(rangeNeeds({ tab: "live", drawer: "aaaaaaaaaaaa" }).sessions).toBe(true);
  });

  it("falls back to a 60 s timer unless an interval is saved", () => {
    expect(AGENTS_SYNC_FALLBACK_S).toBe(60);
    expect(agentsSyncSeconds(undefined, SYNC_CHOICES)).toBe(60);
    expect(agentsSyncSeconds({}, SYNC_CHOICES)).toBe(60);
    expect(agentsSyncSeconds({ agents: 10 }, SYNC_CHOICES)).toBe(10);
    expect(agentsSyncSeconds({ agents: 0 }, SYNC_CHOICES)).toBe(0);
    expect(agentsSyncSeconds({ agents: 7 }, SYNC_CHOICES)).toBe(60);
  });

  it("reports the real age of the last successful fetch", () => {
    const now = Date.now();
    expect(freshnessOf({ okAt: null, now })).toMatchObject({ state: "loading", text: "Loading…" });
    expect(freshnessOf({ okAt: now - 2000, now })).toMatchObject({ state: "ok", text: "Updated just now", btn: "Pause" });
    expect(freshnessOf({ okAt: now - 42_000, now }).text).toBe("Updated 42 s ago");
    expect(freshnessOf({ okAt: now - 185_000, now }).text).toBe("Updated 3 min ago");
    expect(freshnessOf({ okAt: now - 42_000, failed: true, now })).toMatchObject({ state: "error", text: "Update failed · last updated 42 s ago" });
    expect(freshnessOf({ okAt: null, failed: true, now })).toMatchObject({ state: "error", text: "Update failed · no data yet" });
    expect(freshnessOf({ okAt: now - 90_000, paused: true, now })).toMatchObject({ state: "paused", text: "Paused · updated 1 min ago", btn: "Resume" });
  });

  it("shows clock times in IST", () => {
    expect(istClock(Date.parse("2026-11-14T13:17:05Z"))).toBe("18:47:05 IST");
    expect(istClock(NaN)).toBe("");
  });
});

// The routing-override batch follows the live session list, which changes more often than a request takes.
describe("agents overrides poller", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  // Requests the test completes by hand.
  function poller() {
    const calls = [];
    const p = createTrailingPoller({ gapMs: OVERRIDES_GAP_MS, run: (ids) => new Promise((resolve) => calls.push({ ids, resolve })) });
    return { p, calls };
  }
  const settle = async (call) => { call.resolve(); await vi.advanceTimersByTimeAsync(0); };

  it("a change while the request is in flight gets a trailing run with the newest list", async () => {
    const { p, calls } = poller();
    p.request(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.ids)).toEqual([["a"]]);
    // `live` changes twice during the request: nothing is cancelled, nothing starts twice.
    p.request(["a", "b"]);
    p.request(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(1);
    await settle(calls[0]);
    // The gap counts from the end of the request, then the trailing run goes without a further change.
    await vi.advanceTimersByTimeAsync(OVERRIDES_GAP_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => c.ids)).toEqual([["a"], ["a", "b", "c"]]);
    await settle(calls[1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2); // nothing owed, nothing runs
    expect(p.pending()).toBe(false);
  });

  it("runs at once when the last request ended long ago, and survives a failed request", async () => {
    const calls = [];
    const p = createTrailingPoller({ gapMs: OVERRIDES_GAP_MS, run: (ids) => { calls.push(ids); return Promise.reject(new Error("offline")); } });
    p.request(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    p.request(["b"]);
    await vi.advanceTimersByTimeAsync(OVERRIDES_GAP_MS);
    expect(calls).toEqual([["a"], ["b"]]);
    await vi.advanceTimersByTimeAsync(OVERRIDES_GAP_MS + 1);
    p.request(["c"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([["a"], ["b"], ["c"]]);
  });

  it("cancel drops a waiting run", async () => {
    const { p, calls } = poller();
    p.request(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    await settle(calls[0]);
    p.request(["b"]);
    p.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });
});
