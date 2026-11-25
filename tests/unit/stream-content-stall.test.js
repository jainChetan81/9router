import { describe, expect, it } from "vitest";

import { createStreamController, hasSseContent, pipeWithDisconnect, readSseTextWithContentDeadline } from "../../open-sse/utils/streamHandler.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();
const PING = "event: ping\ndata: {\"type\": \"ping\"}\n\n";
const DELTA = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"x\"}}\n\n";

// Upstream that emits `frame` every `everyMs` and errors when the controller aborts.
function makeUpstream(frame, everyMs, signal, { sse = true, maxFrames = Infinity } = {}) {
  let timer;
  let sent = 0;
  const body = new ReadableStream({
    start(c) {
      timer = setInterval(() => {
        if (++sent > maxFrames) { clearInterval(timer); c.close(); return; }
        c.enqueue(enc.encode(frame));
      }, everyMs);
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ }
      });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(body, { headers: { "content-type": sse ? "text/event-stream" : "application/json" } });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

function run({ frame, everyMs, sse = true, maxFrames, contentMs, stallMs = 60000 }) {
  const sc = createStreamController({ log: { line() {}, errorLine() {} }, provider: "t", model: "m" });
  const upstream = makeUpstream(frame, everyMs, sc.signal, { sse, maxFrames });
  const passthrough = new TransformStream();
  const out = pipeWithDisconnect(
    upstream, passthrough, sc,
    (msg) => buildStreamErrorBytes(504, msg, FORMATS.CLAUDE),
    stallMs, contentMs
  );
  return readAll(out);
}

describe("hasSseContent", () => {
  it("ignores comments, ping events and whitespace", () => {
    expect(hasSseContent(": ping\n\n")).toBe(false);
    expect(hasSseContent(PING)).toBe(false);
    expect(hasSseContent("event:ping\ndata:{ \"type\":\"ping\" }\r\n\r\n")).toBe(false);
    expect(hasSseContent(enc.encode("\n\n  \n"))).toBe(false);
  });
  it("detects real events", () => {
    expect(hasSseContent(DELTA)).toBe(true);
    expect(hasSseContent(PING + DELTA)).toBe(true);
    expect(hasSseContent("data: [DONE]\n\n")).toBe(true);
  });
});

describe("content stall timer", () => {
  it("aborts a ping-only SSE upstream and emits the terminal frame", async () => {
    const t0 = Date.now();
    const text = await run({ frame: PING, everyMs: 30, contentMs: 200 });
    const dur = Date.now() - t0;
    expect(text).toContain("event: error");
    expect(text).toContain("stream content stall timeout");
    expect(dur).toBeGreaterThanOrEqual(190);
    expect(dur).toBeLessThan(1500);
  });

  it("does not abort while real content arrives below the deadline", async () => {
    const text = await run({ frame: DELTA, everyMs: 80, maxFrames: 8, contentMs: 300 });
    expect(text).not.toContain("event: error");
    expect(text.split("content_block_delta").length - 1).toBeGreaterThanOrEqual(8);
  });

  it("is not armed for non-SSE upstreams", async () => {
    const text = await run({ frame: "{}", everyMs: 30, maxFrames: 15, sse: false, contentMs: 100 });
    expect(text).not.toContain("event: error");
  });
});

describe("readSseTextWithContentDeadline (non-streaming client)", () => {
  it("rejects a ping-only upstream at the content deadline", async () => {
    const ac = new AbortController();
    const res = makeUpstream(PING, 30, ac.signal);
    const t0 = Date.now();
    await expect(readSseTextWithContentDeadline(res, 200)).rejects.toThrow("stream content stall timeout");
    expect(Date.now() - t0).toBeLessThan(1500);
    ac.abort();
  });

  it("returns the full text when content keeps arriving", async () => {
    const ac = new AbortController();
    const res = makeUpstream(DELTA, 80, ac.signal, { maxFrames: 6 });
    const text = await readSseTextWithContentDeadline(res, 300);
    expect(text.split("content_block_delta").length - 1).toBeGreaterThanOrEqual(6);
  });
});
