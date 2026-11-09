import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { collectToolNames, collectStateToolNames, createToolAccumulator, extractToolNames } from "../../open-sse/utils/toolTelemetry.js";
import { collectToolErrors } from "../../src/lib/agents/toolErrors.js";

const previousDataDir = process.env.DATA_DIR;
let tempDataDir;
let db;

beforeAll(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-agents-tools-"));
  process.env.DATA_DIR = tempDataDir;
  vi.resetModules();
  db = await import("../../src/lib/db/index.js");
  await db.initDb();
  await db.saveRequestUsage({
    timestamp: new Date().toISOString(), provider: "openai", model: "gpt-4o", apiKey: "tools-test",
    tokens: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0.01, status: "ok",
    meta: { ua: "Claude Code", combo: "implementer", tools: [{ name: "read", count: 2 }, { name: "search", count: 1 }], toolErrors: [{ name: "read", count: 1 }] },
  });
  await db.saveRequestUsage({
    timestamp: new Date(Date.now() + 1).toISOString(), provider: "openai", model: "gpt-4o-mini", apiKey: "tools-test",
    tokens: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0.01, status: "ok",
    meta: { ua: "Claude Code", combo: "scout", tools: [{ name: "read", count: 1 }] },
  });
  await db.saveRequestUsage({
    timestamp: new Date(Date.now() + 2).toISOString(), provider: "openai", model: "gpt-4o", apiKey: "tools-test",
    tokens: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0.01, status: "ok",
    meta: { ua: "Claude Code", combo: "implementer", toolErrors: [{ name: "read", count: 1 }] },
  });
  await db.saveRequestUsage({
    timestamp: new Date(Date.now() + 3).toISOString(), provider: "openai", model: "gpt-4o", apiKey: "tools-test",
    tokens: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0.01, status: "ok",
    meta: { ua: "Claude Code", combo: "implementer", tools: [{ name: "read", count: 1 }], toolErrors: [{ name: "read", count: 1 }] },
  });
});

afterAll(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

describe("agent tool telemetry", () => {
  it("extracts stream calls from OpenAI, Claude, Responses and Gemini frames", () => {
    const acc = createToolAccumulator();
    collectToolNames(acc, { choices: [{ delta: { tool_calls: [{ index: 9, function: { name: "get_" } }] } }] });
    collectToolNames(acc, { choices: [{ delta: { tool_calls: [{ index: 9, id: "fragmented", function: { name: "weather" } }] } }] });
    collectToolNames(acc, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read" } }] } }] });
    collectToolNames(acc, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read" } }] } }] });
    collectToolNames(acc, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "c2", name: "edit" } });
    collectToolNames(acc, { type: "response.output_item.added", item: { type: "function_call", id: "i3", call_id: "c3", name: "search" } }, "response.output_item.added");
    collectToolNames(acc, { candidates: [{ content: { parts: [{ functionCall: { id: "g4", name: "run" } }] } }] });
    collectStateToolNames(acc, { toolCalls: new Map([[0, { id: "c1", name: "read" }], [1, { id: "c5", name: "write" }]]) });
    expect(acc.rows()).toEqual([{ name: "get_weather", count: 1 }, { name: "read", count: 1 }, { name: "edit", count: 1 }, { name: "search", count: 1 }, { name: "run", count: 1 }, { name: "write", count: 1 }]);
  });

  it("extracts non-streaming calls for all four formats", () => {
    expect(extractToolNames({ choices: [{ message: { tool_calls: [{ id: "a", function: { name: "read" } }] } }] })).toEqual([{ name: "read", count: 1 }]);
    expect(extractToolNames({ content: [{ type: "tool_use", id: "b", name: "edit" }] })).toEqual([{ name: "edit", count: 1 }]);
    expect(extractToolNames({ output: [{ type: "function_call", call_id: "c", name: "search" }] })).toEqual([{ name: "search", count: 1 }]);
    expect(extractToolNames({ candidates: [{ content: { parts: [{ functionCall: { name: "run" } }] } }] })).toEqual([{ name: "run", count: 1 }]);
  });

  it("caps calls and sanitizes invalid names", () => {
    const acc = createToolAccumulator();
    for (let index = 0; index < 55; index++) acc.add(`id-${index}`, index === 0 ? "bad name" : `tool${index}`);
    expect(acc.rows()).toHaveLength(50);
    expect(acc.rows()[0]).toEqual({ name: "unknown", count: 1 });
  });

  it("bounds streamed name fragments and marks an oversized name unknown", () => {
    const acc = createToolAccumulator();
    for (let index = 0; index < 10000; index += 1) {
      collectToolNames(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: `x${index}` } }] } }] });
    }
    expect(acc.rows()).toEqual([{ name: "unknown", count: 1 }]);
  });

  it("bounds an oversized first fragment and preserves invalid state after rekey", () => {
    const acc = createToolAccumulator();
    acc.add(null, "x".repeat(65), "openai:0", true);
    acc.add("known-id", "valid_name", "openai:0", true);
    expect(acc.rows()).toEqual([{ name: "unknown", count: 1 }]);
  });

  it("counts only new tool errors from the trailing user turn", () => {
    const beforeResult = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read" }] },
    ] };
    const firstError = { messages: [...beforeResult.messages,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
    ] };
    expect(collectToolErrors(firstError)).toEqual([{ name: "read", count: 1 }]);
    const sameToolAgain = { messages: [...firstError.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] },
    ] };
    expect(collectToolErrors(sameToolAgain)).toEqual([{ name: "read", count: 1 }]);
    expect(collectToolErrors({ messages: [...sameToolAgain.messages,
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ] })).toEqual([]);
  });

  it("maps consecutive Responses function calls before counting their outputs", () => {
    expect(collectToolErrors({ input: [
      { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file" },
      { type: "function_call", id: "item-2", call_id: "call-2", name: "search" },
      { type: "function_call_output", call_id: "call-1", is_error: true, output: "failed" },
      { type: "function_call_output", call_id: "call-2", is_error: true, output: "failed" },
    ] })).toEqual([{ name: "read_file", count: 1 }, { name: "search", count: 1 }]);
  });

  it("keeps stored errors when a row has fewer calls than failures", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { getTools } = await import("../../src/lib/agents/queries.js");
    await db.saveRequestUsage({
      timestamp: new Date(Date.now() + 4).toISOString(), provider: "openai", model: "gpt-4o", apiKey: "tools-test",
      tokens: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0.01, status: "ok",
      meta: { ua: "Claude Code", combo: "implementer", tools: [{ name: "batch", count: 1 }], toolErrors: [{ name: "batch", count: 3 }] },
    });
    const result = await getTools(await getAdapter(), new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 60000).toISOString());
    expect(result.tools.find((tool) => tool.name === "batch")).toMatchObject({ calls: 1, errors: 3, errorPct: 100 });
  });

  it("aggregates tools, errors, roles, models and role leaders from the temp database", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { getTools } = await import("../../src/lib/agents/queries.js");
    const adapter = await getAdapter();
    const result = await getTools(adapter, new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 60000).toISOString());
    expect(result.tools[0]).toMatchObject({ name: "read", calls: 4, errors: 3, topModel: { model: "gpt-4o", calls: 3 } });
    expect(result.tools[0].errorPct).toBe(75);
    expect(result.tools[0].byRole).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "implementer", calls: 3, errors: 3 }),
      expect.objectContaining({ role: "scout", calls: 1, errors: 0 }),
    ]));
    expect(result.topToolsByRole).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "implementer", tools: expect.arrayContaining([expect.objectContaining({ name: "read", calls: 3 })]) }),
    ]));
  });
});
