import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

const { createSSEStream } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

async function collectTTFT({ format, mode = "translate", provider = "openai", chunks }) {
  let ttftAt = null;
  let tokenSentAt = null;
  const stream = createSSEStream({
    mode,
    targetFormat: format,
    sourceFormat: format,
    provider,
    body: { stream: true },
    onStreamComplete: (_content, _usage, firstSemanticAt) => { ttftAt = firstSemanticAt; },
  });
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const output = (async () => {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  const encoder = new TextEncoder();

  for (const chunk of chunks) {
    if (chunk.delayBefore) await new Promise((resolve) => setTimeout(resolve, 15));
    if (chunk.semantic) tokenSentAt = performance.now();
    await writer.write(encoder.encode(chunk.text));
  }
  await writer.close();
  await output;
  return { ttftAt, tokenSentAt };
}

describe("stream TTFT telemetry", () => {
  it.each([
    {
      label: "OpenAI chat",
      format: FORMATS.OPENAI,
      mode: "passthrough",
      chunks: [
        { text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' },
        { text: 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', delayBefore: true, semantic: true },
      ],
    },
    {
      label: "Claude tool use",
      format: FORMATS.CLAUDE,
      chunks: [
        { text: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n\n' },
        { text: 'event: ping\ndata: {"type":"ping"}\n\n' },
        { text: 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup","input":{}}}\n\n', delayBefore: true, semantic: true },
      ],
    },
    {
      label: "OpenAI Responses function arguments",
      format: FORMATS.OPENAI_RESPONSES,
      chunks: [
        { text: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","output":[{"type":"function_call","name":"lookup"}]}}\n\n' },
        { text: 'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":"}\n\n', delayBefore: true, semantic: true },
      ],
    },
    {
      label: "Gemini content part",
      format: FORMATS.GEMINI,
      chunks: [
        { text: 'data: {"modelVersion":"gemini-test","usageMetadata":{"promptTokenCount":1},"candidates":[{"finishReason":"STOP"}]}\n\n' },
        { text: 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n', delayBefore: true, semantic: true },
      ],
    },
  ])("starts at the first semantic token for $label", async ({ format, mode, chunks }) => {
    const { ttftAt, tokenSentAt } = await collectTTFT({ format, mode, chunks });
    expect(ttftAt).toBeGreaterThanOrEqual(tokenSentAt);
  });

  it.each([
    { label: "tool call name", delta: { tool_calls: [{ index: 0, function: { name: "lookup" } }] } },
    { label: "reasoning text", delta: { reasoning_content: "thinking" } },
  ])("counts OpenAI $label as semantic", async ({ delta }) => {
    const { ttftAt, tokenSentAt } = await collectTTFT({
      format: FORMATS.OPENAI,
      mode: "passthrough",
      chunks: [{ text: `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`, semantic: true }],
    });
    expect(ttftAt).toBeGreaterThanOrEqual(tokenSentAt);
  });

  it.each([
    "response.output_text.delta",
    "response.function_call_arguments.delta",
    "response.reasoning_summary_text.delta",
  ])("counts Responses %s as semantic", async (eventName) => {
    const { ttftAt, tokenSentAt } = await collectTTFT({
      format: FORMATS.OPENAI_RESPONSES,
      chunks: [{
        text: `event: ${eventName}\ndata: ${JSON.stringify({ type: eventName, delta: "x" })}\n\n`,
        semantic: true,
      }],
    });
    expect(ttftAt).toBeGreaterThanOrEqual(tokenSentAt);
  });
});
