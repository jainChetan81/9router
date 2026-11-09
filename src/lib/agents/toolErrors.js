const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function safeName(name) {
  return typeof name === "string" && SAFE_NAME.test(name) ? name : "unknown";
}

export function collectToolErrors(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let messageStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      messageStart = index + 1;
      break;
    }
  }
  const namesById = new Map();
  for (const message of messages.slice(Math.max(0, messageStart - 1))) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_use" && typeof block.id === "string") namesById.set(block.id, safeName(block.name));
    }
  }
  const input = Array.isArray(body?.input) ? body.input : [];
  let inputStart = 0;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.type === "function_call" || input[index]?.role === "assistant") {
      inputStart = index + 1;
      break;
    }
  }
  for (const item of input.slice(-50)) {
    if (item?.type === "function_call" && typeof (item.call_id || item.id) === "string") {
      namesById.set(item.call_id || item.id, safeName(item.name));
    }
  }
  const counts = new Map();
  const seenErrorIds = new Set();
  for (const message of messages.slice(messageStart)) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_result" && block.is_error === true && typeof block.tool_use_id === "string" && !seenErrorIds.has(block.tool_use_id)) {
        seenErrorIds.add(block.tool_use_id);
        const name = namesById.get(block.tool_use_id) || "unknown";
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  for (const item of input.slice(inputStart)) {
    if (item?.type === "function_call_output" && item.is_error === true && typeof item.call_id === "string" && !seenErrorIds.has(item.call_id)) {
      seenErrorIds.add(item.call_id);
      const name = namesById.get(item.call_id) || "unknown";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}
