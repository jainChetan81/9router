import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createSSEStream, createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
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

  it("invokes onFirstToken once with the semantic timestamp across passthrough, translate, and flush without breaking on errors", async () => {
    const encoder = new TextEncoder();
    const runWithStream = async (stream, writes) => {
      const reader = stream.readable.getReader();
      const writer = stream.writable.getWriter();
      const chunks = [];
      const drain = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      })();
      for (const w of writes) await writer.write(encoder.encode(w));
      await writer.close();
      await drain;
      return chunks.join("");
    };

    const passthroughHits = [];
    let passthroughCompleteAt = null;
    const passthrough = createPassthroughStreamWithLogger(
      "openai",
      null,
      "gpt-4o",
      null,
      { stream: true },
      (_c, _u, t) => { passthroughCompleteAt = t; },
      null,
      null,
      FORMATS.OPENAI,
      (now) => {
        passthroughHits.push(now);
        throw new Error("telemetry boom");
      },
    );
    const out1 = await runWithStream(passthrough, [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(passthroughHits).toHaveLength(1);
    expect(passthroughCompleteAt).toBe(passthroughHits[0]);
    expect(out1).toContain("first");
    expect(out1).toContain("second");

    const translateHits = [];
    let translateCompleteAt = null;
    const translated = createSSETransformStreamWithLogger(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "claude",
      null,
      null,
      "claude-sonnet-4-5",
      null,
      { stream: true },
      (_c, _u, t) => { translateCompleteAt = t; },
      null,
      null,
      null,
      (now) => { translateHits.push(now); },
    );
    await runWithStream(translated, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n',
    ]);
    expect(translateHits).toHaveLength(1);
    expect(translateCompleteAt).toBe(translateHits[0]);

    const flushHits = [];
    const flushOnly = createSSEStream({
      mode: "passthrough",
      eventFormat: FORMATS.OPENAI,
      provider: "openai",
      body: { stream: true },
      onFirstToken: (now) => { flushHits.push(now); },
    });
    await runWithStream(flushOnly, [
      'data: {"choices":[{"delta":{"content":"tail-without-newline"}}]}',
    ]);
    expect(flushHits).toHaveLength(1);

    const handlerHits = [];
    const upstream = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"from-handler"}}]}\n\n'));
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const handled = await handleStreamingResponse({
      providerResponse: upstream,
      provider: "openai",
      model: "gpt-4o",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      userAgent: "test",
      body: { stream: true },
      stream: true,
      requestStartTime: Date.now(),
      streamController: {
        signal: new AbortController().signal,
        startTime: Date.now(),
        isConnected: () => true,
        handleComplete: () => {},
        handleError: () => {},
        handleDisconnect: () => {},
        abort: () => {},
      },
      onFirstToken: (now) => { handlerHits.push(now); },
    });
    expect(handled.success).toBe(true);
    const handledReader = handled.response.body.getReader();
    while (!(await handledReader.read()).done);
    expect(handlerHits).toHaveLength(1);
    expect(Number.isFinite(handlerHits[0])).toBe(true);
  });
});
