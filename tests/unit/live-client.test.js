import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_DELAYS_MS, createLiveClient } from "../../src/lib/live/client.js";

class FakeSource {
  constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; this.closed = false; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  event(topic, v) { this.handlers.v?.({ data: JSON.stringify({ topic, v }) }); }
  // The browser is retrying by itself.
  drop() { this.readyState = 0; this.onerror?.(); }
  // The browser gave up (HTTP error such as 429).
  fatal() { this.readyState = 2; this.onerror?.(); }
}

let sources, hidden, client;
const last = () => sources[sources.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  hidden = false;
  client = createLiveClient({
    createSource: (url) => { const s = new FakeSource(url); sources.push(s); return s; },
    isHidden: () => hidden,
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("live client", () => {
  it("shares one connection and closes it with the last subscriber", () => {
    const offA = client.subscribe("usage", () => {});
    const offB = client.subscribe("agents", () => {});
    expect(sources).toHaveLength(1);
    offA();
    expect(last().closed).toBe(false);
    offB();
    expect(last().closed).toBe(true);
  });

  it("reports the server version and moves the tick on every event", () => {
    const seen = [];
    client.subscribe("usage", (s) => seen.push(s));
    last().open();
    last().event("usage", 7);
    last().event("agents", 3); // another topic
    last().event("usage", 8);
    expect(seen).toEqual([{ version: 7, tick: 1 }, { version: 8, tick: 2 }]);
    expect(client.snapshot("usage")).toEqual({ version: 8, tick: 2 });
  });

  it("does not swallow the first server event after the tab becomes visible", () => {
    const seen = [];
    client.subscribe("usage", (s) => seen.push(s));
    last().open();
    last().event("usage", 5);

    hidden = true;
    client.visibilityChanged();
    expect(last().closed).toBe(true);

    hidden = false;
    client.visibilityChanged();
    expect(sources).toHaveLength(2);
    // The local catch-up moves the tick and leaves the server version alone.
    expect(seen.at(-1)).toEqual({ version: 5, tick: 2 });

    last().open();
    // The next server event is v+1. It must still be a change.
    last().event("usage", 6);
    expect(seen.at(-1)).toEqual({ version: 6, tick: 3 });
    expect(seen).toHaveLength(3);
  });

  it("reconnects with backoff after a fatal error, then catches up", () => {
    const seen = [];
    const status = [];
    client.subscribe("usage", (s) => seen.push(s), (c) => status.push(c));
    last().open();
    expect(status).toEqual([true]);

    for (const [i, delay] of [...RECONNECT_DELAYS_MS, RECONNECT_DELAYS_MS.at(-1)].entries()) {
      last().fatal();
      expect(last().closed).toBe(true);
      vi.advanceTimersByTime(delay - 1);
      expect(sources).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(i + 2);
    }
    expect(seen).toEqual([]);

    last().open();
    expect(status).toEqual([true, false, true]);
    // Events were missed while disconnected: every topic refetches once.
    expect(seen).toEqual([{ version: 0, tick: 1 }]);

    // The backoff starts over after a good connection.
    last().fatal();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(sources).toHaveLength(RECONNECT_DELAYS_MS.length + 3);
  });

  it("catches up after the browser's own reconnect", () => {
    const seen = [];
    client.subscribe("usage", (s) => seen.push(s));
    last().open();
    last().drop();
    expect(sources).toHaveLength(1); // no second connection: the browser retries
    vi.advanceTimersByTime(120000);
    expect(sources).toHaveLength(1);
    last().open();
    expect(seen).toEqual([{ version: 0, tick: 1 }]);
  });

  it("does not reconnect while hidden or without subscribers", () => {
    const off = client.subscribe("usage", () => {});
    last().fatal();
    hidden = true;
    client.visibilityChanged();
    vi.advanceTimersByTime(120000);
    expect(sources).toHaveLength(1);

    hidden = false;
    client.visibilityChanged();
    expect(sources).toHaveLength(2);
    last().fatal();
    off();
    vi.advanceTimersByTime(120000);
    expect(sources).toHaveLength(2);
  });
});
