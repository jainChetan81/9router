// Native Claude must preserve signed thinking blocks byte-for-byte, including
// Fable blocks with empty visible text. Other providers still drop empty thinking.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";
import { isValidClaudeSignature } from "../../open-sse/utils/claudeSignature.js";

const FABLE_SIGNATURE = "CAQSswUKEAgTGAI4AUIIdGhpbmtpbmcSDEL9LkpumeaBjK3iYxoMcuuyoJn9eYE1kyrlIjA9A1sk28mhn39Xx49TwtXqDy2oRNXtBWayX0Hak6pM34TEIomGjJjqAGbhFFau8Gsq0AQ6Q+fhqvTQmYPij9BFjz18DUBAHRjF8UhlZfvwKje0F9j2dnffQT1kLk18RhUNCm8SMm/bSVWr/2/gygzPPTabl38yUdh4G6EL7Ab2dkbBalUF6B8VyvQ7bINFxIWdV6/8g+O0UsYcU9MGQrXIk2WdvWXW2HVp7RRzOrvxpPlGlTtMka2idAdnnu40eTOImmk532P6/vQDJBXdjgihYOwtPHusMwQnyHajqLrpy9yMXnITLY10f2sYvNetBr2DDqf2qellj60bY68JNeUsT/7t5hoRqkpLQghO/BRrhZ9CM6XxwnZ4X+nn5IN7Q0mPhWrVTguK8OFBMEVXDwcyOkUKz3WfP5ctb13JDBnRyDw3BuBvRAVT4uzgoalWksw8QQK63c/O/PfRXMq3NX+PWY8/CwpEmYDSqphDXF9yrhOh3SBhy56K3VvYLL7u7Q2PMceucwv+Afe6MZOCXn+jX+ExSLFWMDrCGtbGqeBwL9Ky6YUahdwdnTUyk4Nk+eMZdYYSGT22a+JHOYCUzPR6ic+IiLo3o9YtEHJt/T65tPV9KqLbHEsPRvXIDXaNPnFtCAKvsOkW+vPjE42FNsduETTn7URIpgAwtIyl8G4oVjE42xVJhvpcTNMTuc2RXreLq6EnVhdUL5PC/y+kHzSULHAgjGCxpeojyJrpE272RV8Kfk3Bgd1ZF3kRp7jWziFXnllhJUnnI2AaAifK94TS8cGjGFCtF5b3QpfWGjgX4zLcQDS1Nfq0JbCW0gKZWN5+ZUYM4pr348aP7WwS4mlgr1diGAE=";

const assistant = (blocks) => ({ role: "assistant", content: blocks });
const thinking = (text) => ({ type: "thinking", thinking: text, signature: DEFAULT_THINKING_CLAUDE_SIGNATURE });
const unsignedThinking = (text) => ({ type: "thinking", thinking: text });

const claudeRequest = (messages) => ({
  model: "deepseek-v4.1-flash",
  max_tokens: 1024,
  messages,
});

describe("Claude signature validation", () => {
  it("accepts Fable protobuf signatures and existing E-form signatures", () => {
    expect(isValidClaudeSignature(FABLE_SIGNATURE)).toBe(true);
    expect(isValidClaudeSignature(DEFAULT_THINKING_CLAUDE_SIGNATURE)).toBe(true);
  });

  it.each(["", "not-a-signature", Buffer.from([0x08, 0x01, 0x13]).toString("base64"), Buffer.from([0x08, 0x80]).toString("base64")])(
    "rejects invalid signature %j",
    signature => expect(isValidClaudeSignature(signature)).toBe(false),
  );
});

describe("normalizeClaudePassthrough — blank thinking blocks", () => {
  it("keeps an empty Fable-signed thinking block unchanged", () => {
    const block = { type: "thinking", thinking: "", signature: FABLE_SIGNATURE };
    const out = normalizeClaudePassthrough({
      messages: [{ role: "user", content: "hi" }, assistant([block])],
    });

    expect(out.messages[1].content).toEqual([block]);
  });

  it("drops an empty unsigned thinking block and keeps its sibling text block", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        assistant([unsignedThinking(""), { type: "text", text: "kept" }]),
      ],
    });

    expect(out.messages[1].content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("drops a whitespace-only thinking block", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        assistant([unsignedThinking("  \n\t "), { type: "text", text: "kept" }]),
      ],
    });

    expect(out.messages[1].content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("drops the whole message when the blank thinking block was its only content", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        assistant([unsignedThinking("   ")]),
      ],
    });

    expect(out.messages.some(m => m.role === "assistant")).toBe(false);
  });

  it("keeps a thinking block that has visible text", () => {
    const block = thinking("considered it");
    const out = normalizeClaudePassthrough({
      messages: [{ role: "user", content: "hi" }, assistant([block, { type: "text", text: "kept" }])],
    });

    expect(out.messages[1].content).toEqual([block, { type: "text", text: "kept" }]);
  });
});

// The translated path (CC → non-native provider over the Claude transport):
// prepareClaudeRequest's deepSeekServed branch keeps thinking unconditionally, so
// a blank block rode through to the upstream and 400'd the request.
describe("prepareClaudeRequest — blank thinking blocks (native Claude)", () => {
  it("preserves the two-turn Fable tool history and its signed thinking block unchanged", () => {
    const block = { type: "thinking", thinking: "", signature: FABLE_SIGNATURE };
    const history = [
      { role: "user", content: "run the tool" },
      assistant([block, { type: "tool_use", id: "toolu_1", name: "lookup", input: {} }]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
    ];
    const out = prepareClaudeRequest(claudeRequest(history), "claude");

    const asst = out.messages.find(m => m.role === "assistant");
    expect(asst.content[0]).toEqual(block);
    expect(asst.content[0]).not.toHaveProperty("cache_control");
    expect(asst.content.map(b => b.type)).toEqual(["thinking", "tool_use"]);
    expect(out.messages.at(-1).content).toEqual(history[2].content);
  });

  it("drops unsigned empty thinking blocks", () => {
    const out = prepareClaudeRequest(claudeRequest([
      { role: "user", content: "hi" },
      assistant([unsignedThinking(""), { type: "text", text: "kept" }]),
    ]), "claude");

    expect(out.messages.find(m => m.role === "assistant").content.map(b => b.type)).toEqual(["text"]);
  });
});

describe("prepareClaudeRequest — blank thinking blocks (deepSeekServed via opencode-go)", () => {
  // prepareClaudeRequest also stamps cache_control on the last non-thinking block
  // of the final assistant, so assert on block kinds + thinking text, not deep equality.
  it("drops a blank thinking block but keeps its sibling text block", () => {
    const out = prepareClaudeRequest(claudeRequest([
      { role: "user", content: "hi" },
      assistant([thinking("   "), { type: "text", text: "kept" }]),
    ]), "opencode-go");

    const asst = out.messages.find(m => m.role === "assistant");
    expect(asst.content.map(b => b.type)).toEqual(["text"]);
    expect(asst.content[0].text).toBe("kept");
  });

  it("keeps a signed thinking block that has visible text (deepSeekServed keeps thinking)", () => {
    const block = thinking("considered it");
    const out = prepareClaudeRequest(claudeRequest([
      { role: "user", content: "hi" },
      assistant([block, { type: "text", text: "kept" }]),
    ]), "opencode-go");

    const asst = out.messages.find(m => m.role === "assistant");
    expect(asst.content.some(b => b.type === "thinking" && b.thinking === "considered it")).toBe(true);
    expect(asst.content.some(b => b.type === "text")).toBe(true);
  });

  it("drops a blank thinking block on the plain deepseek provider too", () => {
    const out = prepareClaudeRequest(claudeRequest([
      { role: "user", content: "hi" },
      assistant([unsignedThinking(""), { type: "text", text: "kept" }]),
    ]), "deepseek");

    const asst = out.messages.find(m => m.role === "assistant");
    expect(asst.content.map(b => b.type)).toEqual(["text"]);
    expect(asst.content[0].text).toBe("kept");
  });
});
