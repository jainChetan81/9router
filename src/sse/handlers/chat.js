import "open-sse/index.js";
import { randomUUID } from "node:crypto";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  completeOpenCodeGoQuotaProbe,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
import { observeRequest, blockMessage } from "@/lib/piiGuard/observe.js";
import { saveFailureUsage } from "open-sse/handlers/chatCore/requestDetail.js";
import { resolveSafeUsageTarget } from "../services/usageTarget.js";
import { register as registerLiveRequest, unregister as unregisterLiveRequest } from "@/lib/agents/liveRegistry.js";

function createUsageContext(request) {
  let settingsPromise = null;
  let keyValidationPromise = null;
  let apiKey = null;
  try { apiKey = extractApiKey(request); } catch { /* malformed request wrappers still get normal handling */ }

  return {
    apiKey,
    getSettings() {
      settingsPromise ||= getSettings();
      return settingsPromise;
    },
    isApiKeyValid() {
      keyValidationPromise ||= apiKey ? isValidApiKey(apiKey).catch(() => false) : Promise.resolve(false);
      return keyValidationPromise;
    },
  };
}

async function recordFailure({ response = null, clientRawRequest, usageContext, statusCode = null, error = null, errorKind = null, aborted = false }) {
  try { unregisterLiveRequest(clientRawRequest?.reqId, aborted ? "aborted" : "error"); } catch { /* live telemetry must fail open */ }
  try {
    const settings = await usageContext.getSettings();
    const validApiKey = await usageContext.isApiKeyValid();
    // A failed key check must never let an unauthenticated caller write usage rows.
    if (settings.requireApiKey && !validApiKey) return response;

    const target = clientRawRequest?.usageTarget || await resolveSafeUsageTarget(clientRawRequest?.body?.model);
    await saveFailureUsage({
      provider: target.provider,
      model: target.model || "invalid",
      connectionId: target.connectionId,
      apiKey: validApiKey ? usageContext.apiKey : null,
      endpoint: clientRawRequest?.endpoint,
      clientRawRequest,
      statusCode: statusCode ?? response?.status ?? null,
      error,
      aborted,
      stream: clientRawRequest?.body?.stream === true,
      errorKind: errorKind || clientRawRequest?.usageState?.failureKind || null,
    });
  } catch { /* usage telemetry must never change the response */ }
  return response;
}

async function withLogicalUsage(responsePromise, clientRawRequest, usageContext) {
  try {
    const response = await responsePromise;
    try {
      if (clientRawRequest) clientRawRequest.usageResponseCommitted = true;
      if (clientRawRequest?.usageState) clientRawRequest.usageState.responseCommitted = true;
      if (Number.isInteger(response?.status) && response.status >= 400) {
        await recordFailure({ response, clientRawRequest, usageContext, statusCode: response.status, aborted: response.status === 499 });
      } else if (response?.body && clientRawRequest?.body?.stream === true) {
        return wrapLiveTerminal(response, clientRawRequest?.reqId);
      } else {
        try { unregisterLiveRequest(clientRawRequest?.reqId, "ok"); } catch { /* live telemetry must fail open */ }
      }
    } catch { /* usage telemetry must never change the response */ }
    return response;
  } catch (error) {
    try {
      if (clientRawRequest) clientRawRequest.usageResponseCommitted = true;
      if (clientRawRequest?.usageState) clientRawRequest.usageState.responseCommitted = true;
      await recordFailure({
        clientRawRequest,
        usageContext,
        statusCode: Number.isInteger(error?.status) ? error.status : null,
        error,
        aborted: error?.name === "AbortError",
      });
    } catch { /* usage telemetry must never change the response */ }
    throw error;
  }
}

function wrapLiveTerminal(response, reqId) {
  if (!response?.body || !reqId) return response;
  try {
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            unregisterLiveRequest(reqId, "ok");
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          unregisterLiveRequest(reqId, error?.name === "AbortError" ? "aborted" : "error");
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { unregisterLiveRequest(reqId, "aborted"); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    return response;
  }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const usageStartedAt = globalThis.performance?.now?.() ?? Date.now();
  const reqId = randomUUID();
  const usageContext = createUsageContext(request);
  if (!clientRawRequest) {
    let endpoint = "";
    try { endpoint = new URL(request.url).pathname; } catch { /* retain empty endpoint */ }
    clientRawRequest = {
      endpoint,
      body: null,
      headers: Object.fromEntries(request.headers.entries()),
    };
  }
  try {
    clientRawRequest.headers ||= Object.fromEntries(request.headers.entries());
    clientRawRequest.reqId = reqId;
    clientRawRequest.usageStartedAt = usageStartedAt;
    clientRawRequest.usageResponseCommitted = false;
    clientRawRequest.validatedApiKey = null;
    clientRawRequest.usageState = { responseCommitted: false, failureRecorded: false, successRecorded: false };
  } catch { /* telemetry context is best-effort */ }
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    const response = errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    return recordFailure({ response, clientRawRequest, usageContext, errorKind: "bad_request" });
  }
  try {
    clientRawRequest.body = body;
  } catch { /* telemetry context is best-effort */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const response = errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid request body");
    return recordFailure({ response, clientRawRequest, usageContext, errorKind: "bad_request" });
  }
  // Resolved before the scan so PII Guard can link stored prompts to the conversation.
  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  clientRawRequest.session = session?.sessionId || null;
  const settings = await usageContext.getSettings();
  const suppliedApiKey = usageContext.apiKey;
  const validApiKey = suppliedApiKey ? await usageContext.isApiKeyValid() : false;
  const apiKey = validApiKey ? suppliedApiKey : null;
  clientRawRequest.validatedApiKey = apiKey;
  let guard;
  if (process.env.PII_GUARD_MODULE) {
    const guardSettings = settings.piiGuard;
    const requested = stripModelContextMarker(body.model).model;
    // Malformed models stay for the normal 400 path below; the combo label is best effort.
    const combo = guardSettings?.mode !== "off" && typeof requested === "string" && requested && await getComboModels(requested).catch(() => null) ? requested : undefined;
    guard = await observeRequest(body, { endpoint: clientRawRequest.endpoint, userAgent: clientRawRequest.headers?.["user-agent"], model: body?.model, sessionId: session?.random ? null : session?.sessionId, combo }, guardSettings);
    if (guard?.blocked) {
      const response = errorResponse(HTTP_STATUS.BAD_REQUEST, blockMessage(guard.blocked, true, guard.stuck));
      return recordFailure({ response, clientRawRequest, usageContext, errorKind: "blocked" });
    }
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const modelInput = typeof body.model === "string" ? body.model.trim() : "";
  const { model: modelStr, contextMarker } = stripModelContextMarker(modelInput);
  if (contextMarker) body.model = modelStr;

  const sessionId = session?.sessionId || null;
  try {
    registerLiveRequest(reqId, { session: sessionId, combo: modelStr, model: modelStr, startedAt: usageStartedAt });
  } catch { /* live telemetry must fail open */ }

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      const response = errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
      return recordFailure({ response, clientRawRequest, usageContext, errorKind: "auth" });
    }
    if (!validApiKey) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      const response = errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
      return recordFailure({ response, clientRawRequest, usageContext, errorKind: "auth" });
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    const response = errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
    return recordFailure({ response, clientRawRequest, usageContext, errorKind: "bad_request" });
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  clientRawRequest.keyAccess = keyAccess;
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return recordFailure({ response: keyAccessDenied, clientRawRequest, usageContext, errorKind: "blocked" });

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) {
    try { unregisterLiveRequest(reqId, "ok"); } catch { /* live telemetry must fail open */ }
    return bypassResponse.response || bypassResponse;
  }

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    clientRawRequest.combo = modelStr;
    clientRawRequest.usageTarget = { provider: null, model: modelStr };
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return withLogicalUsage(handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody, isFusionPanel: true };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, !!isPanel, isPanel ? null : guard, modelStr);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      }), clientRawRequest, usageContext);
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const comboCfg = comboStrategies[modelStr] || {};
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return withLogicalUsage(handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, true, guard, comboModels ? modelStr : null),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      sessionId,
      rawSession: sessionId,
      keyAccess,
      ua: userAgent,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      resolveSmartChoice: comboStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
          })
        : null,
    }), clientRawRequest, usageContext);
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return withLogicalUsage(handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, true, guard, comboModels ? modelStr : null),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      rawSession: sessionId,
      keyAccess,
      ua: userAgent,
    }), clientRawRequest, usageContext);
  }

  return withLogicalUsage(
    handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null, false, guard),
    clientRawRequest,
    usageContext,
  );
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, bodyIsolated = false, piiGuard = null, piiCombo = null) {
  // Combo and fusion callers already isolate each attempt. Direct requests need
  // their own copy before translators and token savers mutate the body.
  if (!bodyIsolated) body = structuredClone(body);
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody, isFusionPanel: true };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, !!isPanel, isPanel ? null : piiGuard, piiCombo || modelStr);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, true, piiGuard, piiCombo || modelStr),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        rawSession: clientRawRequest?.session || nestedSession?.sessionId || null,
        keyAccess: clientRawRequest?.keyAccess || keyAccess,
        ua: clientRawRequest?.headers?.["user-agent"] || request?.headers?.get("user-agent") || "",
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
            })
          : null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    if (clientRawRequest?.usageState) clientRawRequest.usageState.failureKind = "not_found";
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  if (clientRawRequest) {
    clientRawRequest.usageTarget = await resolveSafeUsageTarget(modelStr, modelInfo);
    if (clientRawRequest.usageState) clientRawRequest.usageState.modelResolved = true;
    try {
      registerLiveRequest(clientRawRequest.reqId, {
        session: clientRawRequest.session,
        combo: clientRawRequest.combo || null,
        model: modelStr,
        provider,
        startedAt: clientRawRequest.usageStartedAt,
      });
    } catch { /* live telemetry must fail open */ }
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      requestedModel: requestedModel || model,
      allowQuotaProbe: true,
    });

    if (clientRawRequest && credentials?.connectionId) {
      clientRawRequest.usageTarget = { ...clientRawRequest.usageTarget, connectionId: credentials.connectionId };
    }

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (excludeConnectionIds.size === 0) await piiGuard?.recordRouting?.({ provider, resolvedModel: `${provider}/${model}`, account: null, ...(piiCombo && { combo: piiCombo }) });
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        if (clientRawRequest?.usageState) clientRawRequest.usageState.failureKind = "auth";
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    let quotaProbeFinalized = false;
    try {
    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      customPromptEnabled: !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      modelOverrides: chatSettings.modelOverrides || {},
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    await piiGuard?.recordRouting?.({ provider, resolvedModel: `${provider}/${model}`, account: credentials.connectionName, ...(piiCombo && { combo: piiCombo }) });

    if (result.success) {
      if (credentials.quotaProbe) {
        const completion = await completeOpenCodeGoQuotaProbe(credentials.connectionId, credentials.quotaProbe, "success");
        quotaProbeFinalized = true;
        if (completion.updated) {
          await clearAccountError(credentials.connectionId, { _connection: completion.connection }, model);
        }
      }
      return result.response;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const markResult = provider === "antigravity" && quotaResetMs
      ? true
      : await markAccountUnavailable(
          credentials.connectionId, result.status, result.error, provider, model,
          resetsAtMs, result.quotaFailure, credentials.quotaProbe, credentials.quotaCredentialFingerprint,
        );
    const shouldFallback = markResult === true || markResult.shouldFallback;

    if (credentials.quotaProbe) {
      const outcome = result.quotaFailure?.kind === "opencode-go-paid" ? "quota-error" : "inconclusive";
      await completeOpenCodeGoQuotaProbe(credentials.connectionId, credentials.quotaProbe, outcome);
      quotaProbeFinalized = true;
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
    } finally {
      if (credentials.quotaProbe && !quotaProbeFinalized) {
        await completeOpenCodeGoQuotaProbe(credentials.connectionId, credentials.quotaProbe, "inconclusive");
      }
    }
  }
}
