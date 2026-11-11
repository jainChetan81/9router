import { randomUUID } from "node:crypto";
import { getSettings } from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "./auth.js";
import { saveFailureUsage } from "open-sse/handlers/chatCore/requestDetail.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";

export function readRequestHeaders(request) {
  try {
    if (typeof request?.headers?.entries === "function") {
      return Object.fromEntries(request.headers.entries());
    }
    if (request?.headers && typeof request.headers === "object") {
      return { ...request.headers };
    }
  } catch { /* malformed request wrappers still get normal handling */ }
  return {};
}

export function resolveRequestEndpoint(request, fallbackEndpoint) {
  try {
    if (request?.url) return new URL(request.url).pathname || fallbackEndpoint;
  } catch { /* retain fallback endpoint */ }
  return fallbackEndpoint;
}

export function createMediaUsageContext(request) {
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

export function createMediaRawRequest(request, fallbackEndpoint) {
  return {
    reqId: randomUUID(),
    endpoint: resolveRequestEndpoint(request, fallbackEndpoint),
    usageStartedAt: globalThis.performance?.now?.() ?? Date.now(),
    body: { stream: false },
    headers: readRequestHeaders(request),
    session: null,
    combo: null,
    usageTarget: { provider: null, model: "invalid" },
    usageState: { responseCommitted: false, failureRecorded: false, successRecorded: false },
  };
}

export function resolveExplicitSessionId(headers, body) {
  try {
    const session = resolveSessionIdentity({ headers, body });
    return (!session?.random && !session?.ephemeral && session?.sessionId) ? session.sessionId : null;
  } catch {
    return null;
  }
}

export async function recordMediaFailure({
  response = null,
  clientRawRequest,
  usageContext,
  statusCode = null,
  error = null,
  errorKind = null,
  aborted = false,
}) {
  try {
    const settings = await usageContext.getSettings();
    const validApiKey = await usageContext.isApiKeyValid();
    // Unauthenticated callers with requireApiKey=true must never write usage rows.
    if (settings?.requireApiKey && !validApiKey) return response;

    const target = clientRawRequest?.usageTarget || { provider: null, model: "invalid" };
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
      stream: false,
      errorKind: errorKind || clientRawRequest?.usageState?.failureKind || null,
    });
  } catch { /* usage telemetry must never change the response */ }
  return response;
}

export async function withMediaLogicalUsage(responsePromise, clientRawRequest, usageContext, { isAborted = null } = {}) {
  try {
    const response = await responsePromise;
    try {
      if (clientRawRequest?.usageState) clientRawRequest.usageState.responseCommitted = true;
      if (Number.isInteger(response?.status) && response.status >= 400) {
        const aborted = Boolean(response.status === 499 || isAborted?.());
        await recordMediaFailure({
          response,
          clientRawRequest,
          usageContext,
          statusCode: response.status,
          aborted,
        });
      }
    } catch { /* usage telemetry must never change the response */ }
    return response;
  } catch (error) {
    try {
      if (clientRawRequest?.usageState) clientRawRequest.usageState.responseCommitted = true;
      const aborted = Boolean(error?.name === "AbortError" || isAborted?.());
      await recordMediaFailure({
        clientRawRequest,
        usageContext,
        statusCode: Number.isInteger(error?.status) ? error.status : null,
        error,
        aborted,
      });
    } catch { /* usage telemetry must never change the response */ }
    throw error;
  }
}
