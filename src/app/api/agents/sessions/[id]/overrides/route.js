/**
 * P4 dashboard route from .plan/insertion-points.md §3.8. Next.js exposes the
 * exported `GET`, `PUT`, and `DELETE` handlers at
 * `/api/agents/sessions/[id]/overrides`; GET calls `listOverrides()`, PUT calls
 * `setOverride()`, and DELETE calls `deleteOverride()` in
 * `src/lib/agents/overrideStore.js`. The request-path consumer is wired later
 * in `open-sse/services/combo.js:400` with `getOverride()` and `markActive()`.
 */

import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getComboByName, getCustomModels, getModelAliases, getProviderConnections } from "@/lib/localDb.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getSessionDetail } from "@/lib/agents/queries.js";
import {
  deleteOverride,
  listOverrideRevisions,
  listOverrides,
  loadOverrides,
  OverrideConflictError,
  OverrideNotFoundError,
  OverrideValidationError,
  setOverride,
  validateOverrideInput,
  isValidComboName,
  isValidSession,
} from "@/lib/agents/overrideStore.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import REGISTRY from "open-sse/providers/registry/index.js";

export const dynamic = "force-dynamic";

function jsonError(error, status) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function busyError() {
  return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
}

function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const url = new URL(request.url);
    const host = (request.headers.get("host") || url.host).toLowerCase();
    const parsed = new URL(origin);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/"
      && url.host.toLowerCase() === host
      && parsed.host.toLowerCase() === host
      && parsed.origin === url.origin;
  } catch {
    return false;
  }
}

function providerEntry(prefix) {
  return REGISTRY.find((entry) =>
    entry?.id === prefix || entry?.alias === prefix || entry?.uiAlias === prefix || entry?.aliases?.includes(prefix)
  ) || null;
}

function targetProviderInfo(prefix) {
  const entry = providerEntry(prefix);
  const id = entry?.id || prefix;
  const alias = entry?.alias || entry?.uiAlias || prefix;
  return {
    id,
    aliases: new Set([prefix, id, alias, entry?.uiAlias, ...(entry?.aliases || [])].filter(Boolean)),
  };
}

function isChatModel(model) {
  const kind = model?.kind || model?.type;
  return !kind || kind === "llm" || kind === "imageToText";
}

async function resolveTargetModel(target, depth = 0) {
  if (typeof target !== "string" || !target.trim() || target.length > 256 || depth > 2) return null;
  const model = target.trim();

  const combo = await getComboByName(model);
  if (combo) {
    const settings = await getSettings();
    const strategy = settings.comboStrategies?.[combo.name]?.fallbackStrategy || settings.comboStrategy || "fallback";
    return { exists: true, model, modelId: null, provider: null, combo, fusion: strategy === "fusion" || combo.kind === "fusion" };
  }

  const aliases = await getModelAliases();
  const aliasTarget = aliases?.[model];
  if (typeof aliasTarget === "string" && aliasTarget !== model) {
    return resolveTargetModel(aliasTarget, depth + 1);
  }

  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  const prefix = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const provider = targetProviderInfo(prefix);
  const staticModels = [...provider.aliases].flatMap((alias) => PROVIDER_MODELS[alias] || []);
  const staticMatch = staticModels.find((entry) => entry.id === modelId && isChatModel(entry));
  if (staticMatch) return { exists: true, model, modelId, provider: provider.id, combo: null, fusion: false };

  const [customModels, connections] = await Promise.all([getCustomModels(), getProviderConnections()]);
  const customMatch = (customModels || []).find((entry) =>
    entry?.id === modelId && isChatModel(entry) && provider.aliases.has(entry.providerAlias)
  );
  if (customMatch) return { exists: true, model, modelId, provider: provider.id, combo: null, fusion: false };

  const dynamicMatch = (connections || []).some((connection) => {
    if (connection?.isActive === false || !provider.aliases.has(connection?.provider)) return false;
    const enabled = connection?.providerSpecificData?.enabledModels;
    if (!Array.isArray(enabled)) return false;
    return enabled.some((candidate) => {
      if (typeof candidate !== "string") return false;
      return candidate === modelId || candidate === model || candidate === `${prefix}/${modelId}`;
    });
  });
  if (dynamicMatch) return { exists: true, model, modelId, provider: provider.id, combo: null, fusion: false };
  return null;
}

async function getSessionContext(session) {
  const db = await getAdapter();
  const detail = await getSessionDetail(db, session);
  if (!detail.firstTs) return null;
  return { isCodex: detail.client === "Codex" };
}

async function getWritableCombo(name) {
  if (name.toLowerCase() === "thinker") return { error: "Fusion combo cannot be overridden", status: 400 };
  const combo = await getComboByName(name);
  if (!combo) return { error: "Combo not found", status: 404 };
  const settings = await getSettings();
  const strategy = settings.comboStrategies?.[name]?.fallbackStrategy || settings.comboStrategy || "fallback";
  if (strategy === "fusion" || combo.kind === "fusion") return { error: "Fusion combo cannot be overridden", status: 400 };
  return { combo };
}

async function routeId(context) {
  try {
    const params = await context?.params;
    const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
    const canonical = isValidSession(id) ? id.toLowerCase() : null;
    return isValidSession(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

export async function GET(request, context) {
  const session = await routeId(context);
  if (!session) return jsonError("Invalid session", 400);
  try {
    await loadOverrides();
    const [overrides, revisions] = await Promise.all([
      listOverrides(session),
      listOverrideRevisions(session),
    ]);
    return NextResponse.json({ session, overrides, revisions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error?.code === "busy") return busyError();
    return jsonError("Unable to load overrides", 500);
  }
}

export async function PUT(request, context) {
  if (!isSameOrigin(request)) return jsonError("Same-origin request required", 403);
  const session = await routeId(context);
  if (!session) return jsonError("Invalid session", 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonError("Invalid JSON body", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Invalid request body", 400);
  const comboName = body.combo;
  if (!isValidComboName(comboName)) return jsonError("Invalid combo", 400);

  try {
    const [comboResult, sessionContext] = await Promise.all([
      getWritableCombo(comboName),
      getSessionContext(session),
    ]);
    if (comboResult.error) return jsonError(comboResult.error, comboResult.status);
    if (!sessionContext) return jsonError("Session not found", 404);

    const resolved = await resolveTargetModel(body.model);
    if (!resolved) return jsonError("Model not found", 404);
    if (resolved.fusion) return jsonError("Fusion combo cannot be used as a target", 400);

    const comboMembers = Array.isArray(comboResult.combo.models) ? comboResult.combo.models : [];
    validateOverrideInput({
      session,
      combo: comboName,
      mode: body.mode,
      model: body.model,
      fallback: body.fallback,
      expiry: body.expiry,
      revision: body.revision,
      confirmExpensive: body.confirmExpensive,
      isCodex: sessionContext.isCodex,
      provider: resolved.provider,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.modelId,
      comboMembers,
    });

    await loadOverrides();
    const override = await setOverride(session, comboName, body, {
      isCodex: sessionContext.isCodex,
      provider: resolved.provider,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.modelId,
      comboMembers,
      actor: "dashboard",
    });
    const { auditWarning, ...publicOverride } = override;
    return NextResponse.json({
      session,
      combo: comboName,
      override: publicOverride,
      ...(auditWarning ? { auditWarning: true } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error?.code === "busy") return busyError();
    if (error instanceof OverrideValidationError) return jsonError(error.message, 400);
    if (error instanceof OverrideConflictError) {
      return NextResponse.json({ error: "Revision conflict", currentRevision: error.currentRevision }, { status: 409 });
    }
    return jsonError("Unable to save override", 500);
  }
}

export async function DELETE(request, context) {
  if (!isSameOrigin(request)) return jsonError("Same-origin request required", 403);
  const session = await routeId(context);
  if (!session) return jsonError("Invalid session", 400);
  const params = new URL(request.url).searchParams;
  const combo = params.get("combo");
  const revisionText = params.get("revision");
  const revision = revisionText != null && /^(0|[1-9]\d*)$/.test(revisionText) ? Number(revisionText) : NaN;
  if (!isValidComboName(combo)) return jsonError("Invalid combo", 400);
  if (!Number.isSafeInteger(revision)) return jsonError("Invalid revision", 400);

  try {
    const sessionContext = await getSessionContext(session);
    if (!sessionContext) return jsonError("Session not found", 404);
    await loadOverrides();
    const result = await deleteOverride(session, combo, revision, { actor: "dashboard" });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OverrideValidationError) return jsonError(error.message, 400);
    if (error instanceof OverrideConflictError) {
      return NextResponse.json({ error: "Revision conflict", currentRevision: error.currentRevision }, { status: 409 });
    }
    if (error instanceof OverrideNotFoundError) return jsonError("Override not found", 404);
    return jsonError("Unable to delete override", 500);
  }
}
