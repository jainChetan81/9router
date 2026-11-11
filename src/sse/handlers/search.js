import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getCombos } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleSearchCore } from "open-sse/handlers/search/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { getKeyAccessContext, enforceKeyAccessProvider } from "../services/keyAccess.js";
import { observeRequest, blockMessage } from "@/lib/piiGuard/observe.js";
import { saveUsageStats } from "open-sse/handlers/chatCore/requestDetail.js";
import {
  createMediaUsageContext,
  createMediaRawRequest,
  resolveExplicitSessionId,
  recordMediaFailure,
  withMediaLogicalUsage,
} from "../services/mediaUsage.js";

function resolveSafeSearchUsageTarget(providerInput, combos = null) {
  if (typeof providerInput !== "string" || !providerInput.trim()) {
    return { provider: null, model: "invalid", combo: null };
  }
  const input = providerInput.trim();
  if (Array.isArray(combos) && getComboModelsFromData(input, combos)) {
    return { provider: null, model: input, combo: input };
  }
  const providerId = resolveProviderId(input);
  const resolvedProvider = AI_PROVIDERS[providerId];
  if (!resolvedProvider) return { provider: null, model: "invalid", combo: null };
  const supportsSearch = !!resolvedProvider.searchConfig || !!resolvedProvider.searchViaChat;
  return {
    provider: providerId,
    model: supportsSearch ? providerId : "invalid",
    combo: null,
  };
}

function applySafeSearchTarget(clientRawRequest, target) {
  if (!clientRawRequest || !target) return;
  clientRawRequest.usageTarget = { provider: target.provider, model: target.model };
  if (target.combo) clientRawRequest.combo = target.combo;
}

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
  const usageContext = createMediaUsageContext(request);
  const clientRawRequest = createMediaRawRequest(request, "/v1/search");

  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    log.warn("SEARCH", "Invalid JSON body");
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  clientRawRequest.session = resolveExplicitSessionId(clientRawRequest.headers, body);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
  let providerInput = body.provider || body.model;
  let query = body.query;

  log.request("POST", `${clientRawRequest.endpoint} | ${providerInput}`);

  // Log API key (masked)
  const suppliedApiKey = usageContext.apiKey;
  if (suppliedApiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(suppliedApiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await usageContext.getSettings();
  const validApiKey = suppliedApiKey ? await usageContext.isApiKeyValid() : false;
  const apiKey = validApiKey ? suppliedApiKey : null;
  if (settings.requireApiKey) {
    if (!suppliedApiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    if (!validApiKey) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("SEARCH", "Missing provider/model");
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  let cachedCombos = null;
  const loadCombos = async () => {
    cachedCombos ??= await getCombos();
    return cachedCombos;
  };

  if (!query || typeof query !== "string" || !query.trim()) {
    log.warn("SEARCH", "Missing query");
    applySafeSearchTarget(clientRawRequest, resolveSafeSearchUsageTarget(providerInput, await loadCombos().catch(() => [])));
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  let guard;
  if (process.env.PII_GUARD_MODULE) {
    const combosForGuard = await loadCombos();
    const combo = settings.piiGuard?.mode !== "off" && getComboModelsFromData(providerInput, combosForGuard) ? providerInput : undefined;
    guard = await observeRequest(body, {
      endpoint: clientRawRequest.endpoint,
      userAgent: request?.headers?.get?.("user-agent") ?? clientRawRequest.headers["user-agent"] ?? null,
      model: providerInput,
      combo,
    }, settings.piiGuard);
    if (guard?.blocked) {
      applySafeSearchTarget(clientRawRequest, resolveSafeSearchUsageTarget(providerInput, combosForGuard));
      return recordMediaFailure({
        response: errorResponse(HTTP_STATUS.BAD_REQUEST, blockMessage(guard.blocked, false)),
        clientRawRequest,
        usageContext,
        errorKind: "blocked",
      });
    }
    providerInput = body.provider || body.model; // redaction may have rewritten it
    query = body.query;
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await loadCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  applySafeSearchTarget(clientRawRequest, resolveSafeSearchUsageTarget(providerInput, combos));

  // Per-key access control: the provider IS the model here, so a
  // restricted key needs the provider id (or the combo) on its list.
  const keyAccessDenied = await enforceKeyAccessProvider(await getKeyAccessContext(request), providerInput, comboModels);
  if (keyAccessDenied) {
    return recordMediaFailure({
      response: keyAccessDenied,
      clientRawRequest,
      usageContext,
      errorKind: "blocked",
    });
  }

  const isAborted = () => Boolean(request?.signal?.aborted);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("SEARCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return withMediaLogicalUsage(handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey, settings, guard, providerInput, clientRawRequest),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    }), clientRawRequest, usageContext, { isAborted });
  }

  return withMediaLogicalUsage(
    handleSingleProviderSearch(body, providerInput, request, apiKey, settings, guard, null, clientRawRequest),
    clientRawRequest,
    usageContext,
    { isAborted }
  );
}

async function handleSingleProviderSearch(body, providerInput, request, apiKey, settings, guard, combo, clientRawRequest) {
  const query = body.query;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("SEARCH", "Unknown provider", { provider: providerInput });
    if (clientRawRequest) {
      clientRawRequest.usageTarget = { provider: null, model: combo || "invalid" };
      if (clientRawRequest.usageState) clientRawRequest.usageState.failureKind = "not_found";
    }
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.searchConfig;
  const supportsSearch = !!providerConfig || !!resolvedProvider.searchViaChat;

  if (!supportsSearch) {
    log.warn("SEARCH", "Provider does not support web search", { provider: providerId });
    if (clientRawRequest) {
      clientRawRequest.usageTarget = { provider: providerId, model: combo || "invalid" };
      if (clientRawRequest.usageState) clientRawRequest.usageState.failureKind = "bad_request";
    }
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web search`);
  }

  if (clientRawRequest) {
    clientRawRequest.usageTarget = { provider: providerId, model: providerId };
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // Sanitized body forwarded to core
  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  // No-auth providers (e.g. searxng) bypass credential lookup
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: null,
      log
    });
    await guard?.recordRouting?.({ provider: providerId, resolvedModel: providerId, account: null, ...(combo && { combo }) });
    if (result.success) {
      await saveUsageStats({
        provider: providerId,
        model: providerId,
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        connectionId: null,
        apiKey,
        endpoint: clientRawRequest?.endpoint,
        clientRawRequest,
        label: "SEARCH",
        silent: true,
      });
      return result.response;
    }
    return result.response;
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Credential fallback: some search providers reuse the API key of a related
  // chat provider (e.g. ollama-search reuses the `ollama` chat key, zai-search
  // reuses the `glm` chat key). When the search provider has no own connection,
  // fall back to the linked provider's credentials.
  const fallbackProviderId = resolvedProvider.credentialFallback;

  // Lock scope for this handler. Without it markAccountUnavailable would write
  // an account-wide `__all` lock, which on the credentialFallback path takes
  // the shared chat key (e.g. glm) offline for chat as well. Must be passed to
  // getProviderCredentials too, so the lock is read back under the same key.
  const searchLockKey = `websearch:${providerId}`;

  while (true) {
    // Provider that actually owns the connection in use — differs from
    // providerId once we fall back, and error locks must be attributed to it.
    let credentialProviderId = providerId;
    let credentials = await getProviderCredentials(providerId, excludeConnectionIds, searchLockKey);

    // Fall back to the related chat provider's credentials when this search
    // provider has none of its own (one key, chat + search).
    if (!credentials && fallbackProviderId) {
      credentials = await getProviderCredentials(fallbackProviderId, excludeConnectionIds, searchLockKey);
      if (credentials) {
        credentialProviderId = fallbackProviderId;
        log.info("AUTH", `\x1b[32m${providerId} reusing ${fallbackProviderId} credentials\x1b[0m`);
      }
    }

    if (!credentials || credentials.allRateLimited) {
      if (excludeConnectionIds.size === 0) await guard?.recordRouting?.({ provider: providerId, resolvedModel: providerId, account: null, ...(combo && { combo }) });
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SEARCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        if (clientRawRequest?.usageState) clientRawRequest.usageState.failureKind = "auth";
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("SEARCH", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    if (clientRawRequest && credentials?.connectionId) {
      clientRawRequest.usageTarget = { ...clientRawRequest.usageTarget, connectionId: credentials.connectionId };
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials);
      }
    });

    await guard?.recordRouting?.({ provider: providerId, resolvedModel: providerId, account: credentials.connectionName, ...(combo && { combo }) });
    if (result.success) {
      await saveUsageStats({
        provider: providerId,
        model: providerId,
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        connectionId: credentials.connectionId,
        apiKey,
        endpoint: clientRawRequest?.endpoint,
        clientRawRequest,
        label: "SEARCH",
        silent: true,
      });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, credentialProviderId, searchLockKey);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
