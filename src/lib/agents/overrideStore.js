/**
 * Wiring from .plan/insertion-points.md §3: the future hook at
 * `open-sse/services/combo.js:400` should await `loadOverrides()` for each
 * combo request (the loaded path is an in-memory no-op, and a failed load is
 * retried after bounded backoff), then call
 * `resolveSessionOverride({ rawSession, combo, comboMembers, keyAccess, ua })`
 * synchronously. `keyAccess._sets` must already be populated by the normal
 * request's `enforceKeyAccess()` check. The Next route at
 * `src/app/api/agents/sessions/[id]/overrides/route.js` uses
 * `listOverrides()`, `setOverride()`, and `deleteOverride()` for dashboard
 * GET, PUT, and DELETE requests. `getOverride()` never reads the database.
 */

import fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { DATA_DIR } from "@/lib/dataDir.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { sessionKey } from "./sessionKey.js";

const STORE_KEY = Symbol.for("9router.agents.overrideStore");
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const EXPIRY_MS = Object.freeze({ "1h": 60 * 60 * 1000, "2h": 2 * 60 * 60 * 1000 });
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;
const LOAD_RETRY_MS = 30 * 1000;
const TARGET_TTL_MS = 30 * 1000;
const FLUSH_MAX_RETRIES = 5;
const FLUSH_BASE_RETRY_MS = 1000;
const FLUSH_MAX_RETRY_MS = 30 * 1000;
const COMBO_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SESSION_RE = /^[0-9a-f]{12}$/;

const root = globalThis[STORE_KEY] || (globalThis[STORE_KEY] = new Map());

function createState() {
  return {
    kv: makeKv("sessionOverrides"),
    cache: new Map(),
    loaded: false,
    loadPromise: null,
    loadRetryAt: 0,
    loadError: null,
    mutationTail: Promise.resolve(),
    flushPromise: null,
    flushScheduled: false,
    flushRetryAttempt: 0,
    flushRetryTimer: null,
    flushFailureLogged: false,
    errorCount: 0,
    dirtyWrites: new Map(),
    dirtyDeletes: new Set(),
    resolvedTargets: new Map(),
  };
}

const state = root.get(DATA_DIR) || createState();
if (!root.has(DATA_DIR)) root.set(DATA_DIR, state);

export class OverrideValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "OverrideValidationError";
    this.code = "invalid";
  }
}

export class OverrideConflictError extends Error {
  constructor(currentRevision) {
    super("Revision conflict");
    this.name = "OverrideConflictError";
    this.code = "conflict";
    this.currentRevision = currentRevision;
  }
}

export class OverrideNotFoundError extends Error {
  constructor() {
    super("Override not found");
    this.name = "OverrideNotFoundError";
    this.code = "not_found";
  }
}

function cacheKey(session, combo) {
  return `${session}\u001f${combo}`;
}

function kvKey(session, combo) {
  return `${session}:${encodeURIComponent(combo)}`;
}

function parseKvKey(key) {
  if (typeof key !== "string") return null;
  const splitAt = key.indexOf(":");
  if (splitAt < 0) return null;
  const session = key.slice(0, splitAt);
  let combo;
  try { combo = decodeURIComponent(key.slice(splitAt + 1)); }
  catch { return null; }
  if (!isValidSession(session) || !isValidComboName(combo)) return null;
  return { session, combo };
}

function asIso(value, fallback) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function normalizeStored(session, combo, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  if (value.deleted === true) {
    return { session, combo, deleted: true, revision, deletedAt: asIso(value.deletedAt, new Date().toISOString()) };
  }
  if (!["member", "override"].includes(value.mode) || typeof value.model !== "string") return null;
  if (typeof value.fallback !== "boolean") return null;
  if (!(["session", "1h", "2h"].includes(value.expiry))) return null;
  const nowIso = new Date().toISOString();
  const lastUsed = asIso(value.lastUsed, asIso(value.createdAt, nowIso));
  const expiresAt = asIso(value.expiresAt, new Date(Date.parse(lastUsed) + expiryDuration(value.expiry)).toISOString());
  return {
    session,
    combo,
    mode: value.mode,
    model: value.model,
    fallback: value.fallback,
    expiry: value.expiry,
    expiresAt,
    createdAt: asIso(value.createdAt, nowIso),
    lastUsed,
    lastPersistedAt: Date.parse(value.lastUsed || value.createdAt || nowIso) || Date.now(),
    revision,
    status: value.status === "active" ? "active" : "pending",
    resolvedProvider: typeof value.resolvedProvider === "string" ? value.resolvedProvider.slice(0, 128) : null,
    resolvedModel: typeof value.resolvedModel === "string" ? value.resolvedModel.slice(0, 256) : null,
    confirmedExpensive: value.confirmedExpensive === true,
  };
}

function toStored(entry) {
  if (entry.deleted) return { deleted: true, revision: entry.revision, deletedAt: entry.deletedAt };
  return {
    mode: entry.mode,
    model: entry.model,
    fallback: entry.fallback,
    expiry: entry.expiry,
    expiresAt: entry.expiresAt,
    createdAt: entry.createdAt,
    lastUsed: entry.lastUsed,
    revision: entry.revision,
    status: entry.status,
    ...(entry.resolvedProvider ? { resolvedProvider: entry.resolvedProvider } : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.confirmedExpensive ? { confirmedExpensive: true } : {}),
  };
}

async function ensureLoaded() {
  if (state.loaded) return;
  if (state.loadPromise) return state.loadPromise;
  if (state.loadRetryAt > Date.now()) throw state.loadError || new Error("Override store load is cooling down");
  state.loadPromise = (async () => {
    const all = await state.kv.getAll();
    for (const [key, value] of Object.entries(all || {})) {
      const parsed = parseKvKey(key);
      if (!parsed) continue;
      const entry = normalizeStored(parsed.session, parsed.combo, value);
      if (!entry) continue;
      if (entry.deleted && Date.now() - Date.parse(entry.deletedAt) > TOMBSTONE_TTL_MS) {
        queueDelete(cacheKey(parsed.session, parsed.combo));
        continue;
      }
      state.cache.set(cacheKey(parsed.session, parsed.combo), entry);
      if (!entry.deleted && isExpired(entry)) expireEntry(entry);
    }
    enforceCacheCap();
    state.loaded = true;
    state.loadError = null;
    state.loadRetryAt = 0;
    if (state.dirtyWrites.size || state.dirtyDeletes.size) scheduleFlush();
  })().catch((error) => {
    state.loadPromise = null;
    state.loadError = error;
    state.loadRetryAt = Date.now() + LOAD_RETRY_MS;
    state.errorCount += 1;
    throw error;
  });
  return state.loadPromise;
}

export function loadOverrides({ rawSession, combo, comboMembers = [] } = {}) {
  return ensureLoaded().then(async () => {
    await resolveOverrideTarget(rawSession, combo);
    const session = sessionKey(rawSession);
    const entry = session && isValidComboName(combo) ? getOverrideByKey(session, combo) : null;
    if (entry && (entry.mode === "member" || entry.fallback)) {
      await Promise.all((Array.isArray(comboMembers) ? comboMembers : [])
        .filter((target) => target !== entry.model)
        .map((target) => resolveModelTarget(target)));
    }
  });
}

async function resolveOverrideTarget(rawSession, combo) {
  const session = sessionKey(rawSession);
  if (!session || !isValidComboName(combo)) return;
  const entry = getOverrideByKey(session, combo);
  if (!entry) return;
  await resolveModelTarget(entry.model);
}

async function resolveModelTarget(target) {
  if (typeof target !== "string" || !target) return;
  const cached = state.resolvedTargets.get(target);
  if (cached?.expiresAt > Date.now() && cached.provider && cached.model) return cached;
  if (cached?.promise) return cached.promise;

  const pending = { expiresAt: 0, promise: null };
  pending.promise = (async () => {
  let getModelInfo;
  try { ({ getModelInfo } = await import("@/sse/services/model.js")); }
  catch {
    state.errorCount += 1;
    state.resolvedTargets.delete(target);
    return;
  }
  try {
    const info = await getModelInfo(target);
    if (info?.provider && typeof info.model === "string" && info.model) {
      const resolved = {
        provider: resolveProviderId(info.provider),
        model: info.model,
        expiresAt: Date.now() + TARGET_TTL_MS,
      };
      state.resolvedTargets.set(target, resolved);
      return resolved;
    } else {
      state.errorCount += 1;
      state.resolvedTargets.delete(target);
    }
  } catch {
    state.errorCount += 1;
    state.resolvedTargets.delete(target);
  }
  })();
  state.resolvedTargets.set(target, pending);
  try { await pending.promise; }
  finally {
    if (state.resolvedTargets.get(target) === pending) state.resolvedTargets.delete(target);
  }
}

function queueWrite(entry) {
  const key = cacheKey(entry.session, entry.combo);
  state.dirtyDeletes.delete(key);
  state.dirtyWrites.set(key, { kvKey: kvKey(entry.session, entry.combo), value: toStored(entry) });
}

function queueDelete(key) {
  state.dirtyWrites.delete(key);
  state.dirtyDeletes.add(key);
}

function cacheTimestamp(entry) {
  return Date.parse(entry.deleted ? entry.deletedAt : (entry.lastUsed || entry.createdAt)) || 0;
}

function enforceCacheCap() {
  if (state.cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...state.cache.entries()]
    .sort(([keyA, entryA], [keyB, entryB]) => cacheTimestamp(entryA) - cacheTimestamp(entryB) || keyA.localeCompare(keyB));
  for (let index = 0; state.cache.size > MAX_CACHE_ENTRIES && index < oldest.length; index += 1) {
    const [key] = oldest[index];
    state.cache.delete(key);
    queueDelete(key);
  }
  if (state.dirtyDeletes.size) scheduleFlush();
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of state.cache) {
    if (entry.deleted) {
      if (now - Date.parse(entry.deletedAt) > TOMBSTONE_TTL_MS) {
        state.cache.delete(key);
        queueDelete(key);
      }
    } else if (isExpired(entry, now)) {
      expireEntry(entry);
    }
  }
  enforceCacheCap();
}

function scheduleFlushRetry() {
  if (state.flushRetryTimer || !state.dirtyWrites.size && !state.dirtyDeletes.size) return;
  if (state.flushRetryAttempt >= FLUSH_MAX_RETRIES) {
    if (!state.flushFailureLogged) {
      state.flushFailureLogged = true;
      console.error("[Agents] Override store flush failed after bounded retries");
    }
    return;
  }
  const delay = Math.min(FLUSH_BASE_RETRY_MS * (2 ** state.flushRetryAttempt), FLUSH_MAX_RETRY_MS);
  state.flushRetryAttempt += 1;
  state.flushRetryTimer = setTimeout(() => {
    state.flushRetryTimer = null;
    void flushOverrideStore().catch(() => scheduleFlushRetry());
  }, delay);
  state.flushRetryTimer?.unref?.();
}

function clearFlushRetryState() {
  state.flushRetryAttempt = 0;
  state.flushFailureLogged = false;
  if (state.flushRetryTimer) clearTimeout(state.flushRetryTimer);
  state.flushRetryTimer = null;
}

function scheduleFlush() {
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  queueMicrotask(() => {
    state.flushScheduled = false;
    void flushOverrideStore().catch(() => scheduleFlushRetry());
  });
}

function expireEntry(entry) {
  if (entry.deleted) return;
  const tombstone = {
    session: entry.session,
    combo: entry.combo,
    deleted: true,
    revision: entry.revision + 1,
    deletedAt: new Date().toISOString(),
  };
  state.cache.set(cacheKey(entry.session, entry.combo), tombstone);
  queueWrite(tombstone);
  enforceCacheCap();
  scheduleFlush();
}

function isExpired(entry, now = Date.now()) {
  const expiry = Date.parse(entry.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

function toPublic(entry) {
  const { session, combo, deleted, lastPersistedAt, confirmedExpensive, ...value } = entry;
  void lastPersistedAt;
  void confirmedExpensive;
  if (deleted) return null;
  return { session, combo, ...value };
}

function runMutation(operation) {
  const next = state.mutationTail.then(operation, operation);
  state.mutationTail = next.catch(() => {});
  return next;
}

function expiryDuration(expiry) {
  return expiry === "session" ? SESSION_IDLE_MS : EXPIRY_MS[expiry];
}

function safeActor(actor) {
  if (typeof actor !== "string") return "system";
  const value = actor.trim().replace(/[\r\n\t]/g, " ").slice(0, 64);
  return value || "system";
}

let auditFailureLogged = false;

async function appendAudit({ action, session, combo, oldModel, newModel, mode, actor }) {
  const file = path.join(DATA_DIR, "agents", "overrides.jsonl");
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Audit directory is not a real directory");
  await fs.chmod(directory, 0o700);

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    session,
    combo,
    oldModel: oldModel || null,
    newModel: newModel || null,
    mode: mode || null,
    actor: safeActor(actor),
  });
  try {
    const fileStat = await fs.lstat(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("Audit file is not a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await new Promise((resolve, reject) => {
      nodeFs.appendFile(handle.fd, `${line}\n`, { encoding: "utf8" }, (error) => error ? reject(error) : resolve());
    });
  } finally {
    await handle.close();
  }
}

async function tryAppendAudit(entry) {
  try {
    await appendAudit(entry);
    auditFailureLogged = false;
    return false;
  } catch {
    if (!auditFailureLogged) {
      auditFailureLogged = true;
      console.warn("[Agents] Override saved, but audit logging failed");
    }
    return true;
  }
}

export function isValidSession(session) {
  return typeof session === "string" && SESSION_RE.test(session);
}

function canonicalSession(value) {
  const canonical = isValidSession(value) ? value.toLowerCase() : sessionKey(value);
  return isValidSession(canonical) ? canonical : null;
}

export function isValidComboName(combo) {
  return typeof combo === "string" && COMBO_NAME_RE.test(combo);
}

export function validateOverrideInput({
  session,
  combo,
  mode,
  model,
  fallback,
  expiry = "session",
  revision,
  confirmExpensive,
  isCodex = false,
  provider = null,
  resolvedProvider = provider,
  resolvedModel = null,
  comboMembers = [],
}) {
  const canonical = canonicalSession(session);
  if (!canonical) throw new OverrideValidationError("Invalid session");
  if (!isValidComboName(combo)) throw new OverrideValidationError("Invalid combo");
  if (combo.toLowerCase() === "thinker") throw new OverrideValidationError("Fusion combo cannot be overridden");
  if (mode !== "member" && mode !== "override") throw new OverrideValidationError("Invalid mode");
  if (typeof model !== "string" || !model.trim() || model.length > 256) throw new OverrideValidationError("Invalid model");
  if (typeof fallback !== "boolean") throw new OverrideValidationError("Invalid fallback");
  if (!(["session", "1h", "2h"].includes(expiry))) throw new OverrideValidationError("Invalid expiry");
  if (!Number.isSafeInteger(revision) || revision < 0) throw new OverrideValidationError("Invalid revision");

  const target = model.trim();
  const members = Array.isArray(comboMembers) ? comboMembers : [];
  const isMember = members.includes(target);
  if (mode === "member" && !isMember) throw new OverrideValidationError("Model must be a combo member");
  if (isCodex === true && mode === "override" && !isMember && provider !== "openai") {
    throw new OverrideValidationError("Codex overrides require an OpenAI model");
  }
  if (/(opus|fable)/i.test(`${target} ${resolvedProvider || provider || ""}/${resolvedModel || ""}`) && confirmExpensive !== true) {
    throw new OverrideValidationError("Explicit confirmation is required for this model");
  }

  return {
    session: canonical,
    combo,
    mode,
    model: target,
    fallback: mode === "member" ? true : fallback,
    expiry,
    revision,
    resolvedProvider: typeof resolvedProvider === "string" ? resolvedProvider.slice(0, 128) : null,
    resolvedModel: typeof resolvedModel === "string" ? resolvedModel.slice(0, 256) : null,
    confirmedExpensive: confirmExpensive === true,
  };
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function resolvedProviderFor(target, provider = null) {
  if (typeof provider === "string" && provider) return resolveProviderId(provider);
  if (typeof target !== "string") return null;
  const slash = target.indexOf("/");
  return slash > 0 ? resolveProviderId(target.slice(0, slash)) : null;
}

/**
 * Synchronous counterpart to keyAccess.js's async model check. The caller
 * must first run enforceKeyAccess() for the requested combo, which resolves
 * `keyAccess._sets`. The allowed combo grants its own members; other models
 * must match the resolved provider/model identity in `_sets.models`.
 */
export function isResolvedTargetAllowed(keyAccess, target, {
  combo,
  comboMembers = [],
  resolvedProvider = null,
  resolvedModel = null,
} = {}) {
  try {
    if (!keyAccess) return true;
    const sets = keyAccess._sets;
    if (!(sets?.combos instanceof Set) || !(sets?.models instanceof Set)) return false;
    if (!sets.combos.has(lower(combo))) return false;
    if (Array.isArray(comboMembers) && comboMembers.includes(target)) return true;
    if (sets.combos.has(lower(target))) return true;

    const slash = typeof target === "string" ? target.indexOf("/") : -1;
    const provider = resolvedProviderFor(target, resolvedProvider);
    const model = typeof resolvedModel === "string" && resolvedModel
      ? resolvedModel
      : (slash > 0 ? target.slice(slash + 1) : null);
    if (!provider || !model) return false;
    return sets.models.has(`${lower(provider)}/${lower(model)}`);
  } catch {
    state.errorCount += 1;
    return false;
  }
}

function isOpenAIModel(target, provider = null) {
  try {
    return lower(resolvedProviderFor(target, provider)) === "openai";
  } catch {
    state.errorCount += 1;
    return false;
  }
}

/**
 * Resolve one session's routing control from the warmed cache. Call
 * `loadOverrides()` before this function on each combo request; it returns
 * synchronously and never touches KV. A denied or invalid control returns
 * null so normal combo routing remains in effect.
 */
export function resolveSessionOverride({ rawSession, combo, comboMembers = [], keyAccess = null, ua = "" } = {}) {
  try {
    const session = sessionKey(rawSession);
    if (!session || !isValidComboName(combo) || !state.loaded) return null;
    const override = getOverrideByKey(session, combo);
    if (!override) return null;
    const storedOverride = state.cache.get(cacheKey(session, combo));

    const members = Array.isArray(comboMembers)
      ? [...new Set(comboMembers.filter((model) => typeof model === "string" && model))]
      : [];
    const isMember = members.includes(override.model);
    if (override.mode === "member" && !isMember) return null;
    const resolved = state.resolvedTargets.get(override.model);
    if (!resolved) {
      state.errorCount += 1;
      return null;
    }
    if (/(opus|fable)/i.test(`${override.model} ${resolved.provider}/${resolved.model}`) && !storedOverride?.confirmedExpensive) return null;
    if (!isResolvedTargetAllowed(keyAccess, override.model, {
      combo,
      comboMembers: members,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.model,
    })) return null;

    const isCodex = /codex/i.test(typeof ua === "string" ? ua : "");
    if (isCodex && lower(resolved.provider) !== "openai") return null;

    let models = [override.model];
    if (override.mode === "member" || override.fallback) {
      const fallbacks = members.filter((model) => model !== override.model);
      models.push(...fallbacks);
    }
    if (keyAccess) {
      models = models.filter((model, index) => index === 0 || isResolvedTargetAllowed(keyAccess, model, { combo, comboMembers: members }));
    }
    if (isCodex) models = models.filter((model) => isOpenAIModel(model));
    if (models[0] !== override.model) return null;
    const concreteModels = models.map((model) => {
      const target = state.resolvedTargets.get(model);
      return target?.provider && target?.model ? `${target.provider}/${target.model}` : model;
    });
    return { models: concreteModels, override };
  } catch {
    state.errorCount += 1;
    return null;
  }
}

export function getOverrideStoreErrorCount() {
  return state.errorCount;
}

/** Synchronous cache lookup. It never loads the KV store or starts database I/O. */
export function getOverride(session, combo) {
  try {
    const canonical = canonicalSession(session);
    if (!state.loaded || !canonical || !isValidComboName(combo)) return null;
    return getOverrideByKey(canonical, combo);
  } catch {
    state.errorCount += 1;
    return null;
  }
}

function getOverrideByKey(canonical, combo) {
  if (!state.loaded || !isValidSession(canonical) || !isValidComboName(combo)) return null;
  const key = cacheKey(canonical, combo);
  const entry = state.cache.get(key);
  if (!entry || entry.deleted) return null;
  if (isExpired(entry)) {
    expireEntry(entry);
    return null;
  }
  const now = Date.now();
  entry.lastUsed = new Date(now).toISOString();
  if (entry.expiry === "session") entry.expiresAt = new Date(now + SESSION_IDLE_MS).toISOString();
  state.cache.set(key, entry);
  if (now - (entry.lastPersistedAt || 0) >= PERSIST_INTERVAL_MS) {
    entry.lastPersistedAt = now;
    queueWrite(entry);
    scheduleFlush();
  }
  return toPublic(entry);
}

/** Mark a cached override active without blocking the request path on the KV write. */
export function markActive(session, combo) {
  try {
    const canonical = sessionKey(session);
    if (!state.loaded || !canonical || !isValidComboName(combo)) return false;
    const key = cacheKey(canonical, combo);
    const entry = state.cache.get(key);
    if (!entry || entry.deleted) return false;
    if (isExpired(entry)) {
      expireEntry(entry);
      return false;
    }
    const now = Date.now();
    const statusChanged = entry.status !== "active";
    entry.status = "active";
    entry.lastUsed = new Date(now).toISOString();
    if (entry.expiry === "session") entry.expiresAt = new Date(now + SESSION_IDLE_MS).toISOString();
    state.cache.set(key, entry);
    if (statusChanged || now - (entry.lastPersistedAt || 0) >= PERSIST_INTERVAL_MS) {
      entry.lastPersistedAt = now;
      queueWrite(entry);
      scheduleFlush();
    }
    return true;
  } catch {
    return false;
  }
}

export async function listOverrides(session) {
  const canonical = canonicalSession(session);
  if (!canonical) throw new OverrideValidationError("Invalid session");
  await ensureLoaded();
  const overrides = [];
  for (const [key, entry] of state.cache) {
    if (entry.session !== canonical || entry.deleted) continue;
    if (isExpired(entry)) {
      expireEntry(entry);
      continue;
    }
    overrides.push(toPublic(entry));
  }
  return overrides.sort((a, b) => a.combo.localeCompare(b.combo));
}

export async function listOverrideRevisions(session) {
  const canonical = canonicalSession(session);
  if (!canonical) throw new OverrideValidationError("Invalid session");
  await ensureLoaded();
  const revisions = {};
  for (const entry of state.cache.values()) {
    if (entry.session !== canonical) continue;
    if (!entry.deleted && isExpired(entry)) expireEntry(entry);
    const current = state.cache.get(cacheKey(entry.session, entry.combo));
    if (current) revisions[current.combo] = current.revision;
  }
  return revisions;
}

export async function setOverride(session, combo, input, context = {}) {
  const normalized = validateOverrideInput({ session, combo, ...input, ...context });
  await ensureLoaded();
  return runMutation(async () => {
    session = normalized.session;
    const key = cacheKey(session, combo);
    let current = state.cache.get(key) || null;
    if (current && !current.deleted && isExpired(current)) {
      expireEntry(current);
      current = state.cache.get(key);
    }
    const currentRevision = current?.revision || 0;
    if (normalized.revision !== currentRevision) throw new OverrideConflictError(currentRevision);

    const now = new Date();
    const duration = expiryDuration(normalized.expiry);
    const next = {
      session,
      combo,
      mode: normalized.mode,
      model: normalized.model,
      fallback: normalized.fallback,
      expiry: normalized.expiry,
      expiresAt: new Date(now.getTime() + duration).toISOString(),
      createdAt: now.toISOString(),
      lastUsed: now.toISOString(),
      lastPersistedAt: now.getTime(),
      revision: currentRevision + 1,
      status: "pending",
      resolvedProvider: normalized.resolvedProvider,
      resolvedModel: normalized.resolvedModel,
      confirmedExpensive: normalized.confirmedExpensive,
    };
    await state.kv.set(kvKey(session, combo), toStored(next));
    state.dirtyWrites.delete(key);
    state.dirtyDeletes.delete(key);
    state.cache.set(key, next);
    const slash = next.model.indexOf("/");
    const initialProvider = normalized.resolvedProvider || (slash > 0 ? resolveProviderId(next.model.slice(0, slash)) : null);
    const initialModel = normalized.resolvedModel || (slash > 0 ? next.model.slice(slash + 1) : null);
    if (initialProvider && initialModel) state.resolvedTargets.set(next.model, { provider: initialProvider, model: initialModel });
    enforceCacheCap();
    const auditWarning = await tryAppendAudit({
      action: "set",
      session,
      combo,
      oldModel: current && !current.deleted ? current.model : null,
      newModel: next.model,
      mode: next.mode,
      actor: context.actor,
    });
    return { ...toPublic(next), ...(auditWarning ? { auditWarning: true } : {}) };
  });
}

export async function deleteOverride(session, combo, revision, options = {}) {
  const canonical = canonicalSession(session);
  if (!canonical) throw new OverrideValidationError("Invalid session");
  if (!isValidComboName(combo)) throw new OverrideValidationError("Invalid combo");
  if (!Number.isSafeInteger(revision) || revision < 0) throw new OverrideValidationError("Invalid revision");
  await ensureLoaded();
  return runMutation(async () => {
    session = canonical;
    const key = cacheKey(session, combo);
    let current = state.cache.get(key) || null;
    if (current && !current.deleted && isExpired(current)) {
      expireEntry(current);
      current = state.cache.get(key);
    }
    const currentRevision = current?.revision || 0;
    if (revision !== currentRevision) throw new OverrideConflictError(currentRevision);
    if (!current || current.deleted) throw new OverrideNotFoundError();

    const tombstone = {
      session,
      combo,
      deleted: true,
      revision: current.revision + 1,
      deletedAt: new Date().toISOString(),
    };
    await state.kv.set(kvKey(session, combo), toStored(tombstone));
    state.dirtyWrites.delete(key);
    state.dirtyDeletes.delete(key);
    state.cache.set(key, tombstone);
    enforceCacheCap();
    const auditWarning = await tryAppendAudit({
      action: "delete",
      session,
      combo,
      oldModel: current.model,
      newModel: null,
      mode: current.mode,
      actor: options.actor,
    });
    return { session, combo, deleted: true, revision: tombstone.revision, ...(auditWarning ? { auditWarning: true } : {}) };
  });
}

export async function flushOverrideStore() {
  await ensureLoaded();
  if (state.flushPromise) return state.flushPromise;
  pruneCache();
  state.flushPromise = (async () => {
    while (state.dirtyWrites.size || state.dirtyDeletes.size) {
      const writes = new Map(state.dirtyWrites);
      const deletes = new Set(state.dirtyDeletes);
      state.dirtyWrites.clear();
      state.dirtyDeletes.clear();
      try {
        for (const key of deletes) {
          const [session, combo] = key.split("\u001f");
          await state.kv.remove(kvKey(session, combo));
        }
        if (writes.size) {
          const payload = {};
          for (const { kvKey: key, value } of writes.values()) payload[key] = value;
          await state.kv.setMany(payload);
        }
      } catch (error) {
        for (const [key, value] of writes) if (!state.dirtyWrites.has(key)) state.dirtyWrites.set(key, value);
        for (const key of deletes) if (!state.dirtyWrites.has(key)) state.dirtyDeletes.add(key);
        throw error;
      }
    }
    clearFlushRetryState();
  })().finally(() => { state.flushPromise = null; });
  return state.flushPromise;
}
