import { createHash } from "node:crypto";
import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";
import { collectToolErrors } from "@/lib/agents/toolErrors.js";
import { sanitizeToolName } from "../../utils/toolTelemetry.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  // Note: OpenAI Responses usage ({input_tokens, input_tokens_details:{cached_tokens}})
  // also matches this branch. Its prompt is cache-INCLUSIVE and its cache rides in
  // input_tokens_details, so emit it as cached_tokens — the convention
  // canonicalizeUsage() passes through without folding. Reading it here keeps
  // cache accounting correct for /v1/responses and codex traffic.
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens,
      cost: responseBody.usage.cost
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount || 0
    };
  }

  // Ollama format: prompt_eval_count/eval_count at top level (not nested under usage).
  // prompt_eval_cached_count is a cache-read subset of prompt_eval_count (cache-INCLUSIVE).
  if (responseBody.done === true &&
      (responseBody.prompt_eval_count !== undefined || responseBody.eval_count !== undefined)) {
    const prompt = responseBody.prompt_eval_count || 0;
    const completion = responseBody.eval_count || 0;
    const cached = responseBody.prompt_eval_cached_count || 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cached_tokens: cached
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides
  };
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

// Spend page attribution: client app, session hash and combo, from the raw client request.
export function spendMeta(clientRawRequest, tokens, telemetry = null) {
  const h = clientRawRequest?.headers || {};
  const meta = {
    clientEffort: typeof clientRawRequest?.effort?.clientEffort === "string" ? clientRawRequest.effort.clientEffort : null,
    sentEffort: typeof clientRawRequest?.effort?.sentEffort === "string" ? clientRawRequest.effort.sentEffort : null,
    effortSource: ["model-setting", "model-lock", "model-default", "suffix", "client", "provider-default", "executor-default", "none"].includes(clientRawRequest?.effort?.effortSource)
      ? clientRawRequest.effort.effortSource
      : "none",
  };
  if (clientRawRequest) {
    const ua = h["user-agent"] || "";
    meta.ua = ua.slice(0, 80); // always set: marks the row as attributed, even without a user-agent
  }
  if (clientRawRequest?.session) meta.session = createHash("sha256").update(String(clientRawRequest.session)).digest("hex").slice(0, 12);
  if (clientRawRequest?.combo) meta.combo = clientRawRequest.combo;
  if (Number.isFinite(tokens?.cost)) meta.realCost = tokens.cost;
  if (telemetry && typeof telemetry === "object") {
    if (typeof clientRawRequest?.reqId === "string") meta.reqId = clientRawRequest.reqId;
    if (telemetry.latency && typeof telemetry.latency === "object") {
      const { ttftMs, totalMs, stream } = telemetry.latency;
      meta.latency = {
        ttftMs: Number.isFinite(ttftMs) ? Math.max(0, Math.round(ttftMs)) : null,
        totalMs: Number.isFinite(totalMs) ? Math.max(0, Math.round(totalMs)) : 0,
        stream: Boolean(stream),
      };
    }
    if (["ok", "error", "aborted"].includes(telemetry.status)) meta.status = telemetry.status;
  }
  if (Array.isArray(telemetry?.tools) && telemetry.tools.length) {
    meta.tools = telemetry.tools.slice(0, 50).map(({ name, count }) => ({
      name: sanitizeToolName(name), count: Math.min(50, Math.max(0, Number(count) || 0)),
    }));
  }
  const toolErrors = collectToolErrors(clientRawRequest?.body);
  if (toolErrors.length) meta.toolErrors = toolErrors;
  return meta;
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function buildUsageLatency(clientRawRequest, { stream = false, ttftAt = null } = {}) {
  try {
    const now = monotonicNow();
    const startedAt = Number.isFinite(clientRawRequest?.usageStartedAt)
      ? clientRawRequest.usageStartedAt
      : now;
    return {
      ttftMs: stream && Number.isFinite(ttftAt) ? Math.max(0, Math.round(ttftAt - startedAt)) : null,
      totalMs: Math.max(0, Math.round(now - startedAt)),
      stream: Boolean(stream),
    };
  } catch {
    return { ttftMs: null, totalMs: 0, stream: Boolean(stream) };
  }
}

function classifyFailure({ statusCode, error, aborted, errorKind }) {
  if (["bad_request", "auth", "blocked", "not_found"].includes(errorKind)) return errorKind;
  if (aborted || statusCode === 499 || error?.name === "AbortError") return "aborted";
  const errorText = `${error?.name || ""} ${error?.code || ""} ${error?.cause?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (statusCode === 408 || statusCode === 504 || /timeout|timed out|etimedout/.test(errorText)) return "timeout";
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) return "upstream_4xx";
  if (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599) return "upstream_5xx";
  if (/network|fetch failed|econnreset|econnrefused|ehostunreach|eai_again|und_err_socket/.test(errorText)) return "network";
  return "other";
}

function reserveFailureOutcome(clientRawRequest, outcome) {
  const state = clientRawRequest?.usageState;
  if (state?.successRecorded || clientRawRequest?.usageSuccessRecorded || state?.failureRecorded || clientRawRequest?.usageFailureRecorded) return false;
  if (state) {
    state.outcomeRecorded = outcome;
    state.failureRecorded = true;
  } else if (clientRawRequest) {
    clientRawRequest.usageOutcomeRecorded = outcome;
    clientRawRequest.usageFailureRecorded = true;
  }
  return true;
}

function markLogicalSuccess(clientRawRequest) {
  // Fusion panel calls are physical usage rows, but the judge owns the logical outcome.
  if (!clientRawRequest || clientRawRequest.isFusionPanel) return;
  const state = clientRawRequest.usageState;
  if (state) {
    if (!state.failureRecorded) {
      state.successRecorded = true;
      state.outcomeRecorded = "ok";
    }
  } else if (!clientRawRequest.usageFailureRecorded) {
    clientRawRequest.usageSuccessRecorded = true;
    clientRawRequest.usageOutcomeRecorded = "ok";
  }
}

export function saveFailureUsage({ provider, model, tokens, connectionId, apiKey, endpoint, clientRawRequest, statusCode = null, error = null, aborted = false, stream = false, errorKind = null }) {
  try {
    // A fusion panel can fail while the overall request continues to its judge.
    // Only the outer fusion request records the logical failure outcome.
    if (clientRawRequest?.isFusionPanel) return Promise.resolve(false);
    const outcome = aborted || statusCode === 499 || error?.name === "AbortError" ? "aborted" : "error";
    if (!reserveFailureOutcome(clientRawRequest, outcome)) return Promise.resolve(false);

    const classifiedErrorKind = classifyFailure({ statusCode, error, aborted, errorKind });
    const status = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      ? String(statusCode)
      : "error";
    const latency = buildUsageLatency(clientRawRequest, { stream });
    const meta = spendMeta(clientRawRequest, tokens || {}, { latency, status: outcome });
    // Failure rows keep the identifying fields explicit, including direct calls
    // with no resolved session or combo.
    meta.session ??= null;
    meta.combo ??= null;
    meta.ua ??= "";
    meta.reqId ??= typeof clientRawRequest?.reqId === "string" ? clientRawRequest.reqId : null;
    meta.errorKind = classifiedErrorKind;

    const usageTarget = clientRawRequest?.usageTarget;
    return Promise.resolve(saveRequestUsage({
      provider: provider || usageTarget?.provider || "unknown",
      model: model || usageTarget?.model || "invalid",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      timestamp: new Date().toISOString(),
      connectionId: connectionId || undefined,
      apiKey: apiKey || undefined,
      endpoint: endpoint || null,
      status,
      cost: 0,
      meta,
    })).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, clientRawRequest, latency = null, tools = [], label = "USAGE", silent = false }) {
  try {
    // Each physical upstream call writes its own row, including fusion panels and judge.
    // The shared success flag only blocks a later abort/failure row for the logical request.
    markLogicalSuccess(clientRawRequest);
    if (!tokens || typeof tokens !== "object") return Promise.resolve(false);

    const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
    const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

    if (inTokens === 0 && outTokens === 0) return Promise.resolve(false);

    if (!silent) {
      const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
      console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
    }

    // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
    // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
    const normalized = canonicalizeUsage(tokens) || {
      prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
      completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
    };
    const usageLatency = latency || buildUsageLatency(clientRawRequest, {
      stream: clientRawRequest?.body?.stream === true,
    });

    return Promise.resolve(saveRequestUsage({
      provider: provider || "unknown",
      model: model || "unknown",
      tokens: normalized,
      timestamp: new Date().toISOString(),
      connectionId: connectionId || undefined,
      apiKey: apiKey || undefined,
      endpoint: endpoint || null,
      meta: spendMeta(clientRawRequest, tokens, { latency: usageLatency, status: "ok", tools })
    })).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}
