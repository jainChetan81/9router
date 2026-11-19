// Optional client trace headers. They label a usage row and never go upstream.
//   x-9r-trace: one trace name
//   x-9r-tags:  comma-separated tags
export const TRACE_HEADER = "x-9r-trace";
export const TAGS_HEADER = "x-9r-tags";
export const TRACE_NAME_MAX = 128;
export const TRACE_TAG_MAX = 32;
export const TRACE_TAGS_MAX = 10;

// Reads at most this many characters of a header, so a huge value costs little.
const RAW_HEADER_MAX = 2048;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").trim().slice(0, max).trim();
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  let value = headers[name];
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) { value = headers[key]; break; }
    }
  }
  if (Array.isArray(value)) value = value.join(",");
  return typeof value === "string" ? value.slice(0, RAW_HEADER_MAX) : "";
}

/** Returns `{ name, tags }`, or null when the request carries no valid trace data. */
export function parseTraceHeaders(headers) {
  try {
    const name = clean(readHeader(headers, TRACE_HEADER), TRACE_NAME_MAX);
    const tags = [];
    for (const part of readHeader(headers, TAGS_HEADER).split(",")) {
      const tag = clean(part, TRACE_TAG_MAX);
      if (!tag || tags.includes(tag)) continue;
      tags.push(tag);
      if (tags.length >= TRACE_TAGS_MAX) break;
    }
    if (!name && !tags.length) return null;
    return { name: name || null, tags };
  } catch {
    return null;
  }
}

/**
 * Moves the trace headers off the raw client request and onto `trace`.
 * Executors read `clientRawRequest.headers`, so removing them here keeps them
 * away from every provider.
 */
export function takeTraceHeaders(clientRawRequest) {
  if (!clientRawRequest || typeof clientRawRequest !== "object") return null;
  try {
    const headers = clientRawRequest.headers;
    const trace = parseTraceHeaders(headers);
    if (headers && typeof headers === "object") {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === TRACE_HEADER || lower === TAGS_HEADER) delete headers[key];
      }
    }
    clientRawRequest.trace = trace;
    return trace;
  } catch {
    return null;
  }
}

/** Trace for a usage row: the stored value, else parsed from the headers. */
export function traceOf(clientRawRequest) {
  if (!clientRawRequest) return null;
  if (clientRawRequest.trace !== undefined) return clientRawRequest.trace || null;
  return parseTraceHeaders(clientRawRequest.headers);
}

export const COMBO_ATTEMPTS_MAX = 10;
const ATTEMPT_REASONS = new Set(["rate_limit", "timeout", "empty", "error"]);

/** Why a combo member did not serve the request. */
export function classifyAttempt(status, errorText = "", empty = false) {
  if (empty) return "empty";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504 || /timeout|timed out|etimedout/i.test(String(errorText || ""))) return "timeout";
  return "error";
}

/** Adds one failed combo attempt to the request. Keeps at most COMBO_ATTEMPTS_MAX. */
export function recordComboAttempt(clientRawRequest, { model, status = null, reason = "error" } = {}) {
  if (!clientRawRequest || typeof clientRawRequest !== "object") return;
  try {
    const list = Array.isArray(clientRawRequest.comboAttempts) ? clientRawRequest.comboAttempts : (clientRawRequest.comboAttempts = []);
    if (list.length >= COMBO_ATTEMPTS_MAX) return;
    list.push({
      model: clean(String(model || "unknown"), 160) || "unknown",
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      reason: ATTEMPT_REASONS.has(reason) ? reason : "error",
    });
  } catch { /* telemetry must not break a request */ }
}

/** Bounded copy of the failed attempts for a usage row, or null when there are none. */
export function comboAttemptsOf(clientRawRequest) {
  const list = clientRawRequest?.comboAttempts;
  if (!Array.isArray(list) || !list.length) return null;
  return list.slice(0, COMBO_ATTEMPTS_MAX).map(({ model, status, reason }) => ({ model, status, reason }));
}
