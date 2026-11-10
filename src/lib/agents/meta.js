export function parseMeta(raw) {
  if (!raw || raw === "{}") return {};
  try { const v = JSON.parse(raw); return (v && typeof v === "object") ? v : {}; } catch { return {}; }
}

// Model-named combos (claude-*, gpt-*, kimi-*, glm-*, gemini-*, deepseek-*,
// qwen*, muse-*, codex-*, provider/model ids) are not roles. They map to
// "direct" so the Roles legend lists only real combos (N8/A28/A32).
const MODEL_ID_EDGE = /[\/._-]|[0-9]/;
const ROLE_WORDS = new Set(["main", "scout", "reviewer", "thinker", "background", "direct", "invalid", "daily", "__other__"]);

export function isModelNamedCombo(name) {
  const s = String(name || "").toLowerCase().trim();
  if (!s) return false;
  if (ROLE_WORDS.has(s)) return false;
  return MODEL_ID_EDGE.test(s);
}

export function resolveRoleName(name) {
  const c = name == null || name === "" ? "direct" : String(name);
  // "daily"/"invalid" combo names render as Config error rows (view), never as roles.
  if (c === "daily" || c === "invalid") return "direct";
  if (isModelNamedCombo(c)) return "direct";
  return c;
}

export function roleOf(meta) {
  // Role = meta.combo; null combo -> "direct". Model-named combos are direct.
  return resolveRoleName(meta?.combo);
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
  // meta.status missing -> "ok"; "success" (embedding rows) is ok too (A26).
  return status !== "ok" && status !== "success";
}

export function bgRole(sessionClient, role) {
  // Background bucket: raw combo claude-haiku-5-5 inside a Claude Code session
  if (role === "claude-haiku-5-5" && sessionClient === "Claude Code") return "background";
  return resolveRoleName(role);
}

// One role resolution for request rows: the background rule runs on the raw
// combo before model-named combos map to direct.
export function effectiveRole(sessionClient, combo) {
  return bgRole(sessionClient, combo == null || combo === "" ? "direct" : String(combo));
}

// "claude-cli/2.1.319 (external, cli)" -> "2.1.319". Raw user agents stay server-side.
export function clientVersionOf(ua) {
  return String(ua || "").match(/(?:claude[- ](?:cli|code)|codex[\w-]*|open[- ]?code|t3[\w-]*)[/ ]v?(\d+(?:\.\d+){1,3})/i)?.[1] || null;
}
