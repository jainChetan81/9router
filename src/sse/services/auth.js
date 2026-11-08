import crypto from "node:crypto";
import {
  getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools,
  setOpenCodeGoPaidQuotaLock, observeOpenCodeGoPaidQuotaLockIfGeneration,
  updateOpenCodeGoPaidQuotaLockIfGeneration,
  clearOpenCodeGoPaidQuotaLockIfGeneration,
} from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import {
  formatRetryAfter, checkFallbackError, buildModelLockUpdate,
  getConnectionModelAvailability, OPENCODE_GO_PAID_QUOTA_LOCK,
} from "open-sse/services/accountFallback.js";
import {
  MAX_RATE_LIMIT_COOLDOWN_MS, OPENCODE_GO_QUOTA_RECHECK_MS,
  OPENCODE_GO_PROBE_LEASE_MS, TRANSIENT_COOLDOWN_MS,
} from "open-sse/config/errorConfig.js";
import { getModelQuotaScope } from "open-sse/config/providerModels.js";
import { getOpenCodeGoUsage } from "open-sse/services/usage/opencode-go.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();
const quotaProbeLeases = new Map();

function setLatestBlocker(blockers, connectionId, retryAt) {
  const retryAtMs = new Date(retryAt).getTime();
  if (!Number.isFinite(retryAtMs)) return;
  const previousMs = new Date(blockers.get(connectionId) || 0).getTime();
  if (!Number.isFinite(previousMs) || retryAtMs > previousMs) {
    blockers.set(connectionId, new Date(retryAtMs).toISOString());
  }
}

function hasOpenCodeGoPaidQuotaLock(connection) {
  return !!connection?.[OPENCODE_GO_PAID_QUOTA_LOCK];
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  const quotaProbeByConnection = new Map();
  let selectionReturned = false;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;
    const isOpenCodeGo = providerId === "opencode-go";
    const quotaScope = isOpenCodeGo ? getModelQuotaScope("opencode-go", model) : null;
    const now = Date.now();
    for (const [connectionId, lease] of quotaProbeLeases) {
      if (lease.expiresAt <= now) quotaProbeLeases.delete(connectionId);
    }
    const eligibleConnections = connections.filter((c) => {
      if (c.isActive === false) return false;
      if (excludeSet.has(c.id)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      return !(providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel));
    });
    const blockers = new Map();
    const availableConnections = [];

    for (const c of eligibleConnections) {
      const availability = getConnectionModelAvailability(c, model, { now, quotaScope });
      if (!availability.available) {
        setLatestBlocker(blockers, c.id, availability.retryAt);
        continue;
      }

      if (isOpenCodeGo && quotaScope === "paid" && hasOpenCodeGoPaidQuotaLock(c)) {
        const quotaLock = c[OPENCODE_GO_PAID_QUOTA_LOCK];
        const retryAtMs = new Date(quotaLock.retryAt).getTime();
        if (!Number.isFinite(retryAtMs) || retryAtMs <= now) {
          const lease = quotaProbeLeases.get(c.id);
          if (lease && lease.expiresAt > now) {
            setLatestBlocker(blockers, c.id, Math.max(now + 1, lease.expiresAt));
            continue;
          }
          if (lease) quotaProbeLeases.delete(c.id);
          const probe = { generation: quotaLock.generation, token: crypto.randomUUID() };
          quotaProbeLeases.set(c.id, { ...probe, expiresAt: now + OPENCODE_GO_PROBE_LEASE_MS });
          quotaProbeByConnection.set(c.id, probe);
        }
      }

      // Antigravity: skip if live quota is exhausted for this model.
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > now) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          setLatestBlocker(blockers, c.id, quota.resetAt);
          continue;
        }
      }
      availableConnections.push(c);
    }

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${eligibleConnections.length}`);

    if (availableConnections.length === 0) {
      const retryTimes = [...blockers.values()].map((value) => new Date(value).getTime()).filter(Number.isFinite);
      const allEligibleBlocked = eligibleConnections.length > 0 && blockers.size === eligibleConnections.length;
      const earliest = allEligibleBlocked && retryTimes.length
        ? new Date(Math.min(...retryTimes)).toISOString()
        : null;
      if (earliest) {
        const earliestConn = eligibleConnections.find((c) => blockers.get(c.id) === earliest)
          || eligibleConnections.find((c) => blockers.has(c.id));
        log.warn("AUTH", `${provider} | all ${eligibleConnections.length} eligible accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${eligibleConnections.length} eligible accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    const credentialResult = {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
      ...(quotaProbeByConnection.has(connection.id)
        ? { quotaProbe: quotaProbeByConnection.get(connection.id) }
        : {}),
    };
    selectionReturned = true;
    return credentialResult;
  } finally {
    if (!selectionReturned) {
      for (const [connectionId, probe] of quotaProbeByConnection) {
        if (quotaProbeLeases.get(connectionId)?.token === probe.token) quotaProbeLeases.delete(connectionId);
      }
    }
    if (resolveMutex) resolveMutex();
  }
}

function resolveGoUsageResetAt(usage, limitName, now) {
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object") return null;

  let candidates = [];
  const normalizedLimit = typeof limitName === "string" ? limitName.toLowerCase() : "";
  if (normalizedLimit) {
    const matchingName = Object.keys(quotas).find((name) => name.toLowerCase() === normalizedLimit);
    if (matchingName) candidates = [quotas[matchingName]];
  } else {
    candidates = Object.values(quotas).filter((item) => Number(item?.used) >= 100);
  }

  for (const quota of candidates) {
    const resetAtMs = quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN;
    if (Number.isFinite(resetAtMs) && resetAtMs > now) return new Date(resetAtMs).toISOString();
  }
  return null;
}

async function upgradeOpenCodeGoQuotaLockFromUsage(connection, lock, quotaFailure) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    let usage = null;
    if (typeof connection.apiKey === "string" && connection.apiKey.trim()) {
      const proxyOptions = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      usage = await getOpenCodeGoUsage(connection.apiKey, proxyOptions, { signal: controller.signal });
    }
    const now = Date.now();
    const resetAt = resolveGoUsageResetAt(usage, lock.limitName, now)
      || (Number.isFinite(quotaFailure?.resetAtMs) && quotaFailure.resetAtMs > now
        ? new Date(quotaFailure.resetAtMs).toISOString()
        : null);
    if (!resetAt) return;
    await updateOpenCodeGoPaidQuotaLockIfGeneration(connection.id, lock.generation, {
      retryAt: resetAt,
      resetAt,
    });
  } catch {
    // The six-hour lock remains the safe fallback when usage lookup fails.
  } finally {
    clearTimeout(timeout);
  }
}

/** Complete one request-driven paid quota probe using its observed generation. */
export async function completeOpenCodeGoQuotaProbe(connectionId, probe, outcome) {
  if (!connectionId || !probe?.generation || !probe?.token) return { updated: false, connection: null };
  const currentLease = quotaProbeLeases.get(connectionId);
  const ownsLease = currentLease?.token === probe.token;
  let result = { updated: false, connection: null };
  try {
    if (outcome === "success") {
      result = await clearOpenCodeGoPaidQuotaLockIfGeneration(connectionId, probe.generation);
    } else if (outcome === "inconclusive" && (!currentLease || ownsLease)) {
      result = await updateOpenCodeGoPaidQuotaLockIfGeneration(connectionId, probe.generation, {
        retryAt: new Date(Date.now() + TRANSIENT_COOLDOWN_MS).toISOString(),
      });
    }
  } catch {
    result = { updated: false, connection: null };
  } finally {
    const lease = quotaProbeLeases.get(connectionId);
    if (lease?.token === probe.token) quotaProbeLeases.delete(connectionId);
  }
  return result;
}

/**
 * Mark an account unavailable. Typed OpenCode Go exhaustion uses its paid quota field;
 * other errors keep the existing modelLock_${model} behavior.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @param {object|null} quotaFailure - Optional typed executor classification
 * @param {object|null} quotaProbe - Optional generation identity for a paid probe
 * @returns {{ shouldFallback: boolean, cooldownMs: number, quotaLock?: object }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, quotaFailure = null, quotaProbe = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const providerId = resolveProviderId(provider);
  const connections = await getProviderConnections({ provider: providerId });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  if (Number(status) === 429 && quotaFailure?.kind === "opencode-go-paid"
    && providerId === "opencode-go" && getModelQuotaScope("opencode-go", model) === "paid") {
    const now = Date.now();
    const limitName = typeof quotaFailure.limitName === "string" ? quotaFailure.limitName : null;
    const lock = {
      version: 1,
      reason: "GoUsageLimitError",
      limitName,
      observedAt: new Date(now).toISOString(),
      retryAt: new Date(now + OPENCODE_GO_QUOTA_RECHECK_MS).toISOString(),
      resetAt: null,
      generation: crypto.randomUUID(),
    };
    const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Go usage limit exceeded";
    const healthPatch = {
      testStatus: "unavailable",
      lastError: reason,
      errorCode: Number(status),
      lastErrorAt: lock.observedAt,
      backoffLevel: 0,
    };
    const observation = quotaProbe?.generation
      ? await observeOpenCodeGoPaidQuotaLockIfGeneration(connectionId, quotaProbe.generation, lock, healthPatch)
      : await setOpenCodeGoPaidQuotaLock(connectionId, lock, healthPatch);
    if (quotaProbe?.generation && !observation?.updated) {
      return { shouldFallback: true, cooldownMs: OPENCODE_GO_QUOTA_RECHECK_MS };
    }
    if (conn) void upgradeOpenCodeGoQuotaLockFromUsage(conn, lock, quotaFailure);
    const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
    log.warn("AUTH", `${connName} locked ${OPENCODE_GO_PAID_QUOTA_LOCK} for ${Math.round(OPENCODE_GO_QUOTA_RECHECK_MS / 1000)}s [${status}]`);
    return { shouldFallback: true, cooldownMs: OPENCODE_GO_QUOTA_RECHECK_MS, quotaLock: lock };
  }

  if (Number(status) === 429 && quotaFailure?.kind === "opencode-go-paid"
    && providerId === "opencode-go" && getModelQuotaScope("opencode-go", model) === "free") {
    log.warn("GO_QUOTA", `Typed Go quota failure came from free model ${model}; applying model backoff only`);
  }

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, providerId));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no model or paid quota lock remains
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));
  const hasQuotaLock = hasOpenCodeGoPaidQuotaLock(conn);

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0 && !hasQuotaLock) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0 && !hasQuotaLock) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
