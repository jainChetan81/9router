export function parseMeta(raw) {
  if (!raw || raw === "{}") return {};
  try { const v = JSON.parse(raw); return (v && typeof v === "object") ? v : {}; } catch { return {}; }
}

export function roleOf(meta) {
  // Role = meta.combo; null combo -> "direct"
  const c = meta?.combo;
  return (c == null || c === "") ? "direct" : String(c);
}

export function clientOfUa(ua) {
  // reuse spendClient logic inline to avoid import cycles
  const u = (ua || "").toLowerCase();
  if (u.startsWith("claude-cli") || u.includes("claude-code")) return "Claude Code";
  if (u.includes("codex")) return "Codex";
  if (u.startsWith("open-code-review")) return "OpenCode Review";
  if (u.includes("opencode")) return "OpenCode";
  if (u.startsWith("t3")) return "T3 Code";
  if (!u) return "Unknown";
  return "Other";
}

export function latencyOf(meta) {
  const l = meta?.latency;
  if (!l || typeof l !== "object") return { ttftMs: null, totalMs: null, stream: null };
  const ttft = (l.ttftMs == null) ? null : Number(l.ttftMs);
  const total = (l.totalMs == null) ? null : Number(l.totalMs);
  const stream = (l.stream == null) ? null : Boolean(l.stream);
  return {
    ttftMs: Number.isFinite(ttft) ? ttft : null,
    totalMs: Number.isFinite(total) ? total : null,
    stream,
  };
}

export function statusOf(meta, statusCol) {
  const ms = meta?.status;
  if (ms != null && ms !== "") return String(ms);
  if (statusCol != null && statusCol !== "") return String(statusCol);
  return "ok";
}

export function isErrorStatus(status) {
  // meta.status missing -> "ok"; treat only explicit non-ok as error
  return status !== "ok";
}

export function bgRole(sessionClient, role) {
  // Background bucket: role claude-haiku-5-5 inside a Claude Code session
  if (role === "claude-haiku-5-5" && sessionClient === "Claude Code") return "background";
  return role;
}