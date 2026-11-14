import { describe, it, expect, beforeEach, vi } from "vitest";

// Fresh module state per test — the bus stores globals on `global._liveBus`.
beforeEach(async () => {
  vi.resetModules();
  const bus = await import("@/lib/live/bus.js");
  bus.reset();
});

describe("live bus versions", () => {
  it("starts at 0 and increments monotonically per bump", async () => {
    const { bump, version } = await import("@/lib/live/bus.js");
    expect(version("usage")).toBe(0);
    expect(bump("usage")).toBe(1);
    expect(bump("usage")).toBe(2);
    expect(version("usage")).toBe(2);
    expect(version("agents")).toBe(0);
  });

  it("keeps topics independent", async () => {
    const { bump, version } = await import("@/lib/live/bus.js");
    bump("usage");
    bump("usage");
    bump("agents");
    expect(version("usage")).toBe(2);
    expect(version("agents")).toBe(1);
    expect(version("pii")).toBe(0);
  });

  it("ignores invalid topics", async () => {
    const { bump, version } = await import("@/lib/live/bus.js");
    expect(bump(null)).toBe(0);
    expect(bump("")).toBe(0);
    expect(version(null)).toBe(0);
  });
});

describe("live bus subscribe", () => {
  it("delivers topic, version and payload to subscribers", async () => {
    const { bump, subscribe } = await import("@/lib/live/bus.js");
    const events = [];
    const unsub = subscribe((e) => events.push(e));
    bump("usage", { active: 2 });
    unsub();
    bump("usage");
    expect(events.length).toBe(1);
    expect(events[0].topic).toBe("usage");
    expect(events[0].v).toBe(1);
    expect(events[0].data).toEqual({ active: 2 });
  });

  it("returns a no-op unsubscribe for non-function input", async () => {
    const { subscribe } = await import("@/lib/live/bus.js");
    expect(typeof subscribe(null)).toBe("function");
    expect(() => subscribe(null)()).not.toThrow();
  });

  it("does not stop other subscribers when one throws", async () => {
    const { bump, subscribe } = await import("@/lib/live/bus.js");
    const seen = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribe(() => { throw new Error("boom"); });
    const unsub = subscribe((e) => seen.push(e));
    bump("pii");
    unsub();
    errSpy.mockRestore();
    expect(seen.length).toBe(1);
  });
});

describe("live bus coalescing", () => {
  it("collapses rapid bumps into one with the latest payload", async () => {
    vi.useFakeTimers();
    const { bumpCoalesced, version, subscribe } = await import("@/lib/live/bus.js");
    const events = [];
    subscribe((e) => events.push(e));

    bumpCoalesced("usage", { n: 1 }, 250);
    bumpCoalesced("usage", { n: 2 }, 250);
    bumpCoalesced("usage", { n: 3 }, 250);
    expect(events.length).toBe(0);

    vi.advanceTimersByTime(260);
    expect(events.length).toBe(1);
    expect(events[0].data).toEqual({ n: 3 });
    expect(version("usage")).toBe(1);
    vi.useRealTimers();
  });

  it("sends bumps that arrive after the window immediately", async () => {
    vi.useFakeTimers();
    const { bumpCoalesced, version, subscribe } = await import("@/lib/live/bus.js");
    const events = [];
    subscribe((e) => events.push(e));

    bumpCoalesced("agents", undefined, 250);
    vi.advanceTimersByTime(300);
    expect(events.length).toBe(1);
    expect(version("agents")).toBe(1);

    bumpCoalesced("agents", undefined, 250);
    vi.advanceTimersByTime(300);
    expect(events.length).toBe(2);
    expect(version("agents")).toBe(2);
    vi.useRealTimers();
  });

  it("keeps the buffered payload when the timer is already pending", async () => {
    vi.useFakeTimers();
    const { bumpCoalesced, subscribe } = await import("@/lib/live/bus.js");
    const events = [];
    subscribe((e) => events.push(e));

    bumpCoalesced("usage", { n: 1 }, 250);
    vi.advanceTimersByTime(100);
    bumpCoalesced("usage", { n: 2 }, 250);
    vi.advanceTimersByTime(160);

    expect(events.length).toBe(1);
    expect(events[0].data).toEqual({ n: 2 });
    vi.useRealTimers();
  });
});
