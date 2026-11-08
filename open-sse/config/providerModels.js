import REGISTRY from "../providers/registry/index.js";
// PROVIDER_MODELS now built from providers/registry (transport + models co-located)
import { PROVIDER_MODELS } from "../providers/index.js";
import { modelQuotaFamily, modelStrip, modelTargetFormat, modelSupportedFormats, normalizeModelId } from "../providers/models/schema.js";
import { CODEX_REVIEW_SUFFIX, isMuseSparkModel, opencodeFamilyFormats } from "../providers/models/helpers.js";
import { FORMATS } from "../translator/formats.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { parseModelEffortSuffix } from "../utils/modelEffortSuffix.js";
export { PROVIDER_MODELS };

// OpenCode providers sharing the endpoint-family fallback for unknown model ids
const isOpenCodeAlias = (aliasOrId) => !aliasOrId || ["oc", "opencode", "ocg", "opencode-go", "ocz", "opencode-zen"].includes(aliasOrId);


// Helper functions
export function getProviderModels(aliasOrId) {
  return PROVIDER_MODELS[aliasOrId] || [];
}

export function getDefaultModel(aliasOrId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return models?.[0]?.id || null;
}

// Providers whose registry uses dots in version numbers (e.g. "claude-sonnet-4.5").
// For these, we tolerate clients sending dashes ("claude-sonnet-4-5") by normalizing
// digit-hyphen-digit to digit-dot-digit before lookup. Other providers are left untouched.
const DOT_VERSION_PROVIDERS = new Set(["kr", "kiro"]);
const THINKING_TIER_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Find a registry entry by id. For Kiro models, tolerates dash/dot version separators
// ("claude-sonnet-4-5" ~= "claude-sonnet-4.5"). Other providers use exact match only.
function findModel(models, modelId, aliasOrId) {
  if (!models) return undefined;
  const baseModelId = typeof modelId === "string"
    ? modelId.replace(/\([^()]+\)\s*$/, "").trim()
    : modelId;
  const found = models.find(m => m.id === modelId || m.id === baseModelId);
  if (found) return found;
  if (!DOT_VERSION_PROVIDERS.has(aliasOrId)) return undefined;
  const normalized = normalizeModelId(baseModelId);
  if (normalized === baseModelId) return undefined;
  return models.find(m => m.id === normalized);
}

function nearestRegisteredThinkingTier(models, baseId, requestedTier, aliasOrId) {
  if (typeof requestedTier !== "string" || !requestedTier) return requestedTier;
  const normalizedRequest = requestedTier === "off" ? "none"
    : requestedTier === "auto" ? "high"
      : requestedTier;
  const requestIndex = THINKING_TIER_ORDER.indexOf(normalizedRequest);
  if (requestIndex < 0) return requestedTier;

  const registeredTiers = THINKING_TIER_ORDER.filter((tier) =>
    findModel(models, `${baseId}-${tier}`, aliasOrId)
  );
  if (!registeredTiers.length) return requestedTier;

  return registeredTiers.reduce((closest, tier) => {
    const distance = Math.abs(THINKING_TIER_ORDER.indexOf(tier) - requestIndex);
    const closestDistance = Math.abs(THINKING_TIER_ORDER.indexOf(closest) - requestIndex);
    return distance < closestDistance ? tier : closest;
  }, registeredTiers[0]);
}

export function isValidModel(aliasOrId, modelId, passthroughProviders = new Set()) {
  if (passthroughProviders.has(aliasOrId)) return true;
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return false;
  return !!findModel(models, modelId, aliasOrId);
}

export function findModelName(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return modelId;
  const found = findModel(models, modelId, aliasOrId);
  return found?.name || modelId;
}

export function getModelTargetFormat(aliasOrId, modelId) {
  if (isOpenCodeAlias(aliasOrId) && isMuseSparkModel(modelId)) {
    return FORMATS.OPENAI_RESPONSES;
  }
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, aliasOrId);
  if (found) return modelTargetFormat(found);
  // Family fallback keeps modelsFetcher/passthrough ids on their endpoint lane
  if (isOpenCodeAlias(aliasOrId)) return opencodeFamilyFormats(modelId)?.targetFormat || null;
  return null;
}

// Declared upstream formats for a model (registry `supportedFormats`). Drives the
// per-model guard on the sourceFormat-matched transport; null when undeclared.
// Unknown OpenCode ids fall back to the family regex (chat lane by default) so
// auto-fetched models never wrongly use the sourceFormat-matched transport.
export function getModelSupportedFormats(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, aliasOrId);
  if (found) return modelSupportedFormats(found);
  if (isOpenCodeAlias(aliasOrId)) return opencodeFamilyFormats(modelId)?.supportedFormats || [FORMATS.OPENAI];
  return null;
}

export function getModelType(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, aliasOrId);
  return found?.kind || found?.type || null;
}

// Raw registry entry for a model (suffix-aware) — executor lookups of per-model hints (e.g. defaultLocation).
export function getModelMeta(aliasOrId, modelId) {
  return findModel(PROVIDER_MODELS[aliasOrId], modelId, aliasOrId) || null;
}

export function getModelUpstreamId(aliasOrId, modelId, clientBody = null, effortOverride = null) {
  // Normalize both "(level)" and valid Codex "-level" suffixes to the same
  // parenthesized form so applyThinking and usage attribution see one shape.
  const models = PROVIDER_MODELS[aliasOrId];
  const parsedSuffix = parseModelEffortSuffix(modelId, { allowHyphen: true });
  let suffix = "";
  let baseId = modelId;
  if (parsedSuffix.syntax === "parenthesized") {
    baseId = parsedSuffix.cleanModel;
    suffix = parsedSuffix.suffixText;
  } else if (parsedSuffix.syntax === "hyphenated") {
    const fullModel = findModel(models, modelId, aliasOrId);
    const baseModel = findModel(models, parsedSuffix.cleanModel, aliasOrId);
    const providerId = REGISTRY.find((entry) =>
      entry.id === aliasOrId || entry.alias === aliasOrId || entry.aliases?.includes(aliasOrId)
    )?.id || aliasOrId;
    const supportedLevels = baseModel ? getThinkingLevels(providerId, parsedSuffix.cleanModel) : null;
    if (!fullModel && baseModel && supportedLevels?.includes(parsedSuffix.suffix)) {
      baseId = parsedSuffix.cleanModel;
      suffix = parsedSuffix.suffixText;
    }
  }
  const requestedSuffix = typeof effortOverride === "string" && effortOverride
    ? `(${effortOverride.toLowerCase()})`
    : suffix;

  // Some tiered model IDs are fixed presets (for example, gemini-3.8-flash-high
  // maps to an upstream ID ending in (high)). Their registered preset wins over
  // client effort and saved effort overrides. Plain aliases without a matching
  // effort suffix remain selectable from client intent below.
  const registeredModel = findModel(models, baseId, aliasOrId);
  const presetLevel = registeredModel?.upstreamModelId?.match(/\(([^()]+)\)\s*$/)?.[1]?.toLowerCase();
  const idLevel = typeof baseId === "string"
    ? baseId.match(/-(none|minimal|low|medium|high|xhigh|max)$/i)?.[1]?.toLowerCase()
    : null;
  const fixedLevel = idLevel && presetLevel === idLevel ? presetLevel : null;

  // Resolve requested thinking level from suffix or client request body
  const rawSuffix = fixedLevel || (typeof effortOverride === "string" && effortOverride
    ? effortOverride.toLowerCase()
    : suffix ? suffix.slice(1, -1).trim().toLowerCase() : "");
  let tier = rawSuffix;
  if (!tier && clientBody && typeof clientBody === "object") {
    const rawEffort = clientBody.reasoning_effort || clientBody.output_config?.effort || (typeof clientBody.reasoning === "object" ? clientBody.reasoning?.effort : null);
    if (typeof rawEffort === "string" && rawEffort) {
      const v = rawEffort.toLowerCase().trim();
      tier = v;
    } else {
      const geminiThinking = clientBody.thinkingConfig
        || clientBody.generationConfig?.thinkingConfig
        || clientBody.request?.generationConfig?.thinkingConfig;
      if (typeof geminiThinking?.thinkingLevel === "string") {
        tier = geminiThinking.thinkingLevel.toLowerCase().trim();
      } else {
        const thinking = clientBody.thinking;
        const budget = geminiThinking?.thinkingBudget ?? thinking?.budget_tokens;
        const b = Number(budget);
        if (thinking?.type === "disabled" || b === 0) {
          tier = "none";
        } else if (thinking?.type === "adaptive" || (thinking?.type === "enabled" && !Number.isFinite(b)) || b < 0) {
          tier = "auto";
        } else if (Number.isFinite(b) && b > 0) {
          tier = b > 16384 ? "high" : b <= 4096 ? "low" : "medium";
        }
      }
    }
  }
  // Select the closest registered variant when an effort has no exact model
  // tier. This also canonicalizes the suffix to the tier the variant supports.
  if (!fixedLevel) tier = nearestRegisteredThinkingTier(models, baseId, tier, aliasOrId);

  // Look for tiered variant first if a tier was requested (e.g. gemini-3.8-flash-high)
  const tieredId = tier ? `${baseId}-${tier}` : null;
  const tieredModel = tieredId && findModel(models, tieredId, aliasOrId);
  const found = tieredModel || findModel(models, baseId, aliasOrId);
  const resolvedId = found?.upstreamModelId || found?.id;
  if (resolvedId) {
    const presetMatch = resolvedId.match(/\([^()]+\)\s*$/);
    const presetSuffix = presetMatch?.[0] || "";
    const resolvedBase = presetSuffix ? resolvedId.slice(0, presetMatch.index).trim() : resolvedId;
    const resolvedSuffix = fixedLevel
      ? `(${fixedLevel})`
      : tieredModel
        ? (presetSuffix || `(${tier})`)
        : requestedSuffix || (presetSuffix && tier ? `(${tier})` : presetSuffix);
    return resolvedBase + resolvedSuffix;
  }
  if (aliasOrId === "cx" && typeof baseId === "string" && baseId.endsWith(CODEX_REVIEW_SUFFIX)) {
    return baseId.slice(0, -CODEX_REVIEW_SUFFIX.length) + requestedSuffix;
  }
  return baseId + requestedSuffix;
}

export function getModelQuotaFamily(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return modelQuotaFamily(findModel(models, modelId, aliasOrId));
}

// OAuth short aliases — derived from registry `alias` (single source). everything else: alias = id.
// vertex/vertex-partner keep alias=id (kept via the `|| id` fallback in consumers).
export const OAUTH_ALIASES = Object.fromEntries(
  REGISTRY.filter(r => r.alias && r.alias !== r.id).map(r => [r.id, r.alias])
);

// Derived from REGISTRY — no need to maintain manually. REGISTRY (not PROVIDERS):
// media-only entries (elevenlabs, cartesia, inworld, ...) declare no transport, so
// keying off PROVIDERS dropped their alias and made their registry `models`
// unreachable — the exact same map PROVIDER_MODELS is keyed by
// (`entry.alias || entry.id` in providers/index.js).
export const PROVIDER_ID_TO_ALIAS = Object.fromEntries(
  REGISTRY.map(r => [r.id, r.alias || r.id])
);

export function getModelsByProviderId(providerId) {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return PROVIDER_MODELS[alias] || [];
}

// Get strip list for a model entry (explicit opt-in only)
// Returns array of content types to strip, e.g. ["image", "audio"]
export function getModelStrip(alias, modelId) {
  return modelStrip(findModel(PROVIDER_MODELS[alias], modelId, alias));
}
