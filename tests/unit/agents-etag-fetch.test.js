// Client side of the Agents ETag protocol: 304 reuse, the sync signal, and the
// trailing refetch after a server floor window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEtagFetcher } from "../../src/app/(dashboard)/dashboard/agents/etagFetch.js";

const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: String(status),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

let requests, replies, fetcher;
beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  replies = [];
  fetcher = createEtagFetcher({
    fetchImpl: async (url, init) => { requests.push({ url, headers: init.headers || {} }); return replies.shift(); },
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("agents ETag fetcher", () => {
  it("revalidates with If-None-Match and reuses the stored body on 304", async () => {
    const body = { n: 1 };
    replies.push(response(200, body, { etag: 'W/"a"' }), response(304, null));
    expect(await fetcher.getJson("/x")).toBe(body);
    expect(await fetcher.getJson("/x")).toBe(body);
    expect(requests[0].headers).toEqual({});
    expect(requests[1].headers).toEqual({ "If-None-Match": 'W/"a"' });
  });

  it("a sync sends no conditional header and carries x-9r-sync", async () => {
    replies.push(response(200, { n: 1 }, { etag: 'W/"a"' }), response(200, { n: 2 }, { etag: 'W/"b"' }), response(304, null));
    await fetcher.getJson("/x");
    expect(await fetcher.getJson("/x", { sync: true })).toEqual({ n: 2 });
    expect(requests[1].headers).toEqual({ "x-9r-sync": "1" });
    // The fresh answer replaces the stored one for later revalidation.
    expect(await fetcher.getJson("/x")).toEqual({ n: 2 });
    expect(requests[2].headers).toEqual({ "If-None-Match": 'W/"b"' });
  });

  it("runs the caller's loader once after the floor window, so the fresh body reaches the screen", async () => {
    // What a page does: a loader that fetches and puts the body into state.
    let onScreen = null;
    const load = async () => { onScreen = await fetcher.getJson("/x", { reload: load }); };
    replies.push(
      response(200, { old: true }, { etag: 'W/"a"', "x-9r-retry-after-ms": "3000" }),
      response(200, { fresh: true }, { etag: 'W/"b"' }),
    );
    await load();
    expect(onScreen).toEqual({ old: true });
    expect(fetcher.pendingRetries()).toBe(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    expect(onScreen).toEqual({ fresh: true });
    expect(fetcher.pendingRetries()).toBe(0);
  });

  it("schedules nothing without a loader, and a newer request replaces a pending retry", async () => {
    replies.push(response(200, {}, { "x-9r-retry-after-ms": "3000" }));
    await fetcher.getJson("/x");
    expect(fetcher.pendingRetries()).toBe(0);

    const reload = vi.fn();
    replies.push(response(200, {}, { "x-9r-retry-after-ms": "3000" }), response(200, {}));
    await fetcher.getJson("/x", { reload });
    expect(fetcher.pendingRetries()).toBe(1);
    await fetcher.getJson("/x", { reload });
    expect(fetcher.pendingRetries()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("cancelRetries drops every pending retry", async () => {
    const reload = vi.fn();
    replies.push(response(200, {}, { "x-9r-retry-after-ms": "1000" }));
    await fetcher.getJson("/x", { reload });
    fetcher.cancelRetries();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).not.toHaveBeenCalled();
  });
});
