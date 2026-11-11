import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
} from "../services/auth.js";
import { getSettings, getCustomModels } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import * as log from "../utils/logger.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { saveUsageStats } from "open-sse/handlers/chatCore/requestDetail.js";
import {
  createMediaUsageContext,
  createMediaRawRequest,
  resolveExplicitSessionId,
  recordMediaFailure,
  withMediaLogicalUsage,
} from "../services/mediaUsage.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

async function loadCustomSttModels() {
  try {
    const customModels = await getCustomModels();
    return Array.isArray(customModels) ? customModels : [];
  } catch {
    return []; // DB unreadable → built-in registry marker still applies
  }
}

// Custom-model transport marker: models registered through
// /api/models/custom may pin a specialized STT transport (e.g.
// "gemini-live"). The engine dispatches on the marker itself, so the app
// layer only resolves it — same getModelInfo-style provider+model pairing,
// restricted to type "stt" records.
function resolveCustomModelTransportFromList(customModels, provider, model) {
  const hit = customModels.find((c) => c && c.type === "stt"
    && c.providerAlias === provider && c.id === model
    && typeof c.transport === "string" && c.transport.trim());
  return hit ? hit.transport.trim() : null;
}

function isKnownSttModel(provider, model, customModels = []) {
  if (!provider || !model || !AI_PROVIDERS[provider]) return false;
  const alias = PROVIDER_ID_TO_ALIAS[provider];
  const registryModels = PROVIDER_MODELS[alias] || PROVIDER_MODELS[provider] || [];
  if (Array.isArray(registryModels) && registryModels.some((m) => m && m.id === model && (m.kind || "llm") === "stt")) {
    return true;
  }
  const cfgModels = AI_PROVIDERS[provider]?.sttConfig?.models;
  if (Array.isArray(cfgModels) && cfgModels.some((m) => (typeof m === "string" ? m === model : m?.id === model))) {
    return true;
  }
  return Array.isArray(customModels) && customModels.some((c) =>
    c && c.type === "stt" && c.id === model && (c.providerAlias === provider || (alias && c.providerAlias === alias))
  );
}

function resolveSafeSttUsageTarget(provider, model, customModels = []) {
  if (!provider || !AI_PROVIDERS[provider]) return { provider: null, model: "invalid" };
  return {
    provider,
    model: isKnownSttModel(provider, model, customModels) ? model : "invalid",
  };
}

export async function handleStt(request) {
  const usageContext = createMediaUsageContext(request);
  const clientRawRequest = createMediaRawRequest(request, "/v1/audio/transcriptions");

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  const modelStr = formData.get("model");
  const sessionIdField = formData.get("session_id");
  clientRawRequest.session = resolveExplicitSessionId(
    clientRawRequest.headers,
    typeof sessionIdField === "string" ? { session_id: sessionIdField } : undefined,
  );
  log.request("POST", `${clientRawRequest.endpoint} | ${modelStr}`);

  const settings = await usageContext.getSettings();
  const suppliedApiKey = usageContext.apiKey;
  const validApiKey = suppliedApiKey ? await usageContext.isApiKeyValid() : false;
  const apiKey = validApiKey ? suppliedApiKey : null;
  if (settings.requireApiKey) {
    if (!suppliedApiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    if (!validApiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) {
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }
  if (!formData.get("file")) {
    try {
      const info = await getModelInfo(modelStr);
      if (info?.provider) {
        const customModels = await loadCustomSttModels();
        clientRawRequest.usageTarget = resolveSafeSttUsageTarget(info.provider, info.model, customModels);
      }
    } catch { /* retain safe fallback target */ }
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return recordMediaFailure({
      response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format"),
      clientRawRequest,
      usageContext,
      errorKind: "not_found",
    });
  }

  const { provider, model } = modelInfo;
  const customModels = await loadCustomSttModels();
  clientRawRequest.usageTarget = resolveSafeSttUsageTarget(provider, model, customModels);

  if (provider === "codex" && model !== "transcribe") {
    return recordMediaFailure({
      response: errorResponse(400, "Use model cx/transcribe for Codex STT"),
      clientRawRequest,
      usageContext,
      errorKind: "bad_request",
    });
  }

  // Per-key access control: checked before any credential lookup.
  const keyAccessDenied = await enforceKeyAccessResolved(await getKeyAccessContext(request), modelStr, provider, model);
  if (keyAccessDenied) {
    return recordMediaFailure({
      response: keyAccessDenied,
      clientRawRequest,
      usageContext,
      errorKind: "blocked",
    });
  }

  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  const modelTransport = resolveCustomModelTransportFromList(customModels, provider, model);

  return withMediaLogicalUsage(
    executeStt({ request, provider, model, formData, modelTransport, apiKey, clientRawRequest }),
    clientRawRequest,
    usageContext,
    { isAborted: () => Boolean(request?.signal?.aborted) },
  );
}

async function executeStt({ request, provider, model, formData, modelTransport, apiKey, clientRawRequest }) {
  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport });
    if (result.success) {
      await saveUsageStats({
        provider,
        model,
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        connectionId: null,
        apiKey,
        endpoint: clientRawRequest?.endpoint,
        clientRawRequest,
        label: "STT",
        silent: true,
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    let credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        if (clientRawRequest?.usageState) clientRawRequest.usageState.failureKind = "auth";
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    if (clientRawRequest && credentials?.connectionId) {
      clientRawRequest.usageTarget = { ...clientRawRequest.usageTarget, connectionId: credentials.connectionId };
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    let result;
    try {
      const isCodex = provider === "codex";
      if (isCodex) credentials = await checkAndRefreshToken(provider, credentials);
      const proxyOptions = isCodex
        ? await resolveConnectionProxyConfig(credentials._connection?.providerSpecificData || credentials.providerSpecificData)
        : undefined;
      const args = { provider, model, formData, credentials, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport, signal: request?.signal, proxyOptions };
      result = await handleSttCore(args);
      if (isCodex && result.status === 401 && credentials.refreshToken && !request?.signal?.aborted) {
        const previous = credentials.accessToken;
        credentials = await checkAndRefreshToken(provider, credentials, { force: true });
        if (credentials.accessToken !== previous) result = await handleSttCore({ ...args, credentials });
      }
      if (result.success) {
        if (isCodex) await clearAccountError(credentials.connectionId, credentials, model);
        await saveUsageStats({
          provider,
          model,
          tokens: { prompt_tokens: 0, completion_tokens: 0 },
          connectionId: credentials.connectionId,
          apiKey,
          endpoint: clientRawRequest?.endpoint,
          clientRawRequest,
          label: "STT",
          silent: true,
        });
        return result.response;
      }
    } catch {
      return errorResponse(HTTP_STATUS.BAD_GATEWAY, "STT credential or transport failure");
    }

    if (request?.signal?.aborted) return errorResponse(504, "Transcription cancelled");
    // Bad audio / unsupported parameters are client errors, not broken accounts.
    if (provider === "codex" && [400, 413, 504].includes(result.status)) {
      return result.response || errorResponse(result.status, result.error);
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
