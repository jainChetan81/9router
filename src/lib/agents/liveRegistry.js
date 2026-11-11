/**
 * Wiring from .plan/insertion-points.md §1: call `register(reqId, data)` in
 * `src/sse/handlers/chat.js:151`, after session and model resolution. Call
 * `unregister(reqId, outcome)` from `recordFailure()` at
 * `src/sse/handlers/chat.js:56` and from `saveUsageStats()` /
 * `saveFailureUsage()` at `open-sse/handlers/chatCore/requestDetail.js:211,248`.
 * Call `markFirstToken(reqId)` when the semantic first token is observed in
 * `open-sse/handlers/chatCore/streamingHandler.js:126-158`. Merge
 * `snapshot()` into `getLive()` in `src/lib/agents/queries.js:689-786`, at the
 * merge points described in §1.2 (around lines 704 and 769).
 */

import { sessionKey } from "./sessionKey.js";

const REGISTRY_KEY = Symbol.for("9router.agents.liveRegistry");
const MAX_ENTRIES = 500;
const TTL_MS = 10 * 60 * 1000;
// A request that already streams its first token ends through unregister().
// This longer limit only removes entries whose terminal cleanup was missed.
const STREAMING_TTL_MS = 60 * 60 * 1000;

const state = globalThis[REGISTRY_KEY] || (globalThis[REGISTRY_KEY] = { entries: new Map() });

function monotonicNow() {
  try {
    return globalThis.performance?.now?.() ?? Date.now();
  } catch {
    return Date.now();
  }
}

function cleanLabel(value, maxLength = 256) {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label ? label.slice(0, maxLength) : null;
}

function cleanHash(value) {
  if (typeof value !== "string") return null;
  const hash = value.trim();
  // Keep digests only. This prevents accidentally retaining an API key passed
  // under the optional apiKeyHash field.
  return /^(?:sha256:)?[a-f\d]{32,128}$/i.test(hash) ? hash : null;
}

function isExpired(entry, now) {
  return now - entry.registeredAt > (entry.firstTokenAt == null ? TTL_MS : STREAMING_TTL_MS);
}

function pruneExpired(now) {
  // At most MAX_ENTRIES entries, so a full scan is cheap.
  for (const [reqId, entry] of state.entries) {
    if (isExpired(entry, now)) state.entries.delete(reqId);
  }
}

export function register(reqId, data) {
  try {
    const id = cleanLabel(reqId, 128);
    if (!id || !data || typeof data !== "object") return false;

    const session = sessionKey(data.session);
    if (!session) return false;

    const now = Date.now();
    pruneExpired(now);
    if (state.entries.has(id)) state.entries.delete(id);
    while (state.entries.size >= MAX_ENTRIES) {
      const oldest = state.entries.keys().next().value;
      if (oldest === undefined) break;
      state.entries.delete(oldest);
    }

    const startedAt = Number(data.startedAt);
    state.entries.set(id, {
      reqId: id,
      session,
      combo: cleanLabel(data.combo),
      model: cleanLabel(data.model),
      provider: cleanLabel(data.provider),
      apiKeyHash: cleanHash(data.apiKeyHash),
      startedAt: Number.isFinite(startedAt) ? startedAt : monotonicNow(),
      firstTokenAt: null,
      registeredAt: now,
    });
    return true;
  } catch {
    return false;
  }
}

export function markFirstToken(reqId, at = null) {
  try {
    const id = cleanLabel(reqId, 128);
    if (!id) return false;
    const entry = state.entries.get(id);
    if (!entry) return false;
    if (isExpired(entry, Date.now())) {
      state.entries.delete(id);
      return false;
    }
    if (entry.firstTokenAt == null) {
      entry.firstTokenAt = Number.isFinite(at) ? at : monotonicNow();
    }
    return true;
  } catch {
    return false;
  }
}

export function unregister(reqId, outcome) {
  try {
    const id = cleanLabel(reqId, 128);
    if (!id) return false;
    // `outcome` is accepted for the insertion-point contract. Completed
    // requests leave the in-flight registry and their outcome is stored by the
    // usage-history writer instead.
    void outcome;
    return state.entries.delete(id);
  } catch {
    return false;
  }
}

/** Return `{ [session]: [inFlightRequest, ...] }`, with no internal TTL data. */
export function snapshot() {
  try {
    pruneExpired(Date.now());
    const bySession = {};
    for (const entry of state.entries.values()) {
      const request = {
        reqId: entry.reqId,
        session: entry.session,
        combo: entry.combo,
        model: entry.model,
        provider: entry.provider,
        apiKeyHash: entry.apiKeyHash,
        startedAt: entry.startedAt,
        firstTokenAt: entry.firstTokenAt,
      };
      (bySession[entry.session] ||= []).push(request);
    }
    return bySession;
  } catch {
    return {};
  }
}
