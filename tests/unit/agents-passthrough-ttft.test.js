import { describe, it, expect } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const enc = new TextEncoder();
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

async function runClaudePassthrough(eventFormat) {
  let ttftAt;
  const ts = createPassthroughStreamWithLogger("claude", null, "claude-opus-5-5", null, null, (_c, _u, t) => { ttftAt = t; }, null, null, eventFormat);
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const drain = (async () => { while (!(await reader.read()).done); })();
  for (const ev of [
    { type: "message_start", message: { usage: { input_tokens: 3 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "message_delta", usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]) await writer.write(enc.encode(sse(ev)));
  await writer.close();
  await drain;
  return ttftAt;
}

describe("passthrough TTFT", () => {
  it("marks the first token on a Claude passthrough stream", async () => {
    expect(Number.isFinite(await runClaudePassthrough("claude"))).toBe(true);
  });
  it("keeps the old behavior when no event format is given", async () => {
    expect(await runClaudePassthrough(null)).toBe(null);
  });
});
