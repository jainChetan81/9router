const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_TOOL_CALLS = 50;

export function sanitizeToolName(name) {
  return typeof name === "string" && TOOL_NAME_RE.test(name) ? name : "unknown";
}

export function createToolAccumulator() {
  const calls = new Map();
  const aliases = new Map();
  const invalidNames = new Set();
  return {
    add(id, name, fallbackKey = null, appendName = false) {
      const idKey = typeof id === "string" && id ? `id:${id}` : null;
      let key = idKey || (fallbackKey ? aliases.get(fallbackKey) || fallbackKey : null);
      if (!key) return;
      if (idKey && fallbackKey && aliases.has(fallbackKey) && aliases.get(fallbackKey) !== idKey) {
        const oldKey = aliases.get(fallbackKey);
        const oldName = calls.get(oldKey);
        calls.delete(oldKey);
        calls.set(idKey, oldName);
        if (invalidNames.has(oldKey)) {
          invalidNames.delete(oldKey);
          invalidNames.add(idKey);
        }
      }
      if (fallbackKey) aliases.set(fallbackKey, key);
      if (calls.has(key)) {
        if (name && !invalidNames.has(key)) {
          const previous = calls.get(key);
          const next = String(name);
          const combined = appendName && previous && !previous.startsWith(next) && !next.startsWith(previous)
            ? previous + next
            : appendName && previous?.startsWith(next) ? previous : next;
          if (combined.length > 64) {
            calls.set(key, "");
            invalidNames.add(key);
          } else calls.set(key, combined);
        }
        return;
      }
      if (calls.size >= MAX_TOOL_CALLS) return;
      const initialName = typeof name === "string" ? name : "";
      if (initialName.length > 64) {
        calls.set(key, "");
        invalidNames.add(key);
      } else calls.set(key, initialName);
    },
    rows() {
      const counts = new Map();
      for (const rawName of calls.values()) {
        const name = sanitizeToolName(rawName);
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      return [...counts].map(([name, count]) => ({ name, count }));
    },
  };
}

export function collectToolNames(accumulator, value, eventName = "") {
  if (!value || typeof value !== "object") return;
  for (const choice of value.choices || []) {
    for (const [index, call] of (choice.delta?.tool_calls || []).entries()) {
      accumulator.add(call.id, call.function?.name, `openai:${call.index ?? index}`, true);
    }
  }
  if (value.type === "content_block_start" && value.content_block?.type === "tool_use") {
    accumulator.add(value.content_block.id, value.content_block.name, `claude:${value.index ?? value.content_block.id ?? "start"}`);
  }
  const event = eventName || value.type || "";
  if (event === "response.output_item.added" || value.type === "response.output_item.added") {
    const item = value.item || value.data?.item;
    if (item?.type === "function_call" || item?.type === "custom_tool_call") accumulator.add(item.call_id || item.id, item.name, `responses:${item.id || item.call_id || "item"}`);
  }
  for (const [index, part] of (value.candidates?.[0]?.content?.parts || []).entries()) {
    const call = part.functionCall;
    if (call) accumulator.add(call.id, call.name, `gemini:${call.id || `${index}:${call.name}`}`);
  }
}

export function collectStateToolNames(accumulator, state) {
  const calls = state?.toolCalls;
  if (!(calls instanceof Map)) return;
  for (const [index, call] of calls) {
    accumulator.add(call?.id || call?.call_id, call?.name || call?.function?.name, `state:${index}`);
  }
}

export function extractToolNames(response) {
  const acc = createToolAccumulator();
  for (const [index, call] of (response?.choices?.[0]?.message?.tool_calls || []).entries()) {
    acc.add(call.id, call.function?.name, `nonstream:${index}`);
  }
  for (const [index, block] of (response?.content || []).entries()) {
    if (block?.type === "tool_use") acc.add(block.id, block.name, `nonstream:${index}`);
  }
  for (const [index, item] of (response?.output || []).entries()) {
    if (item?.type === "function_call" || item?.type === "custom_tool_call") acc.add(item.call_id || item.id, item.name, `nonstream:${index}`);
  }
  for (const [index, part] of (response?.candidates?.[0]?.content?.parts || []).entries()) {
    if (part.functionCall) acc.add(part.functionCall.id, part.functionCall.name, `nonstream:${index}`);
  }
  return acc.rows();
}
