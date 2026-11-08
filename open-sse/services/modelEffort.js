import { PROVIDER_ID_TO_ALIAS, getModelMeta } from "../config/providerModels.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { resolveProviderAlias } from "./model.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { parseModelEffortSuffix } from "../utils/modelEffortSuffix.js";

// modelOverrides keys use the registry provider ID and canonical registry model ID: codex/gpt-6-luna.
export function getModelEffortKey(provider, model) {
  const canonicalProvider = resolveProviderAlias(provider);
  const alias = PROVIDER_ID_TO_ALIAS[canonicalProvider] || canonicalProvider;
  let cleanModel = stripThinkingSuffix(model);

  // Codex accepts effort as a trailing hyphen suffix (for example,
  // gpt-6-luna-max), but these suffix variants are not registry models. Keep
  // registered ids intact because providers can publish real ids ending in a
  // supported effort word, such as gemini-3.8-flash-high.
  if (!getModelMeta(alias, cleanModel) && typeof cleanModel === "string") {
    const suffixMatch = parseModelEffortSuffix(cleanModel, { allowHyphen: true });
    if (suffixMatch.syntax === "hyphenated") {
      const baseModel = suffixMatch.cleanModel;
      const suffix = suffixMatch.suffix;
      const supportedLevels = getThinkingLevels(canonicalProvider, baseModel) || [];
      if (getModelMeta(alias, baseModel) && supportedLevels.includes(suffix)) {
        cleanModel = baseModel;
      }
    }
  }

  const canonicalModel = getModelMeta(alias, cleanModel)?.id || cleanModel;
  return `${canonicalProvider}/${canonicalModel}`;
}

export function getFixedEffortLevel(provider, model) {
  const canonicalProvider = resolveProviderAlias(provider);
  const cleanModel = stripThinkingSuffix(model);
  const alias = PROVIDER_ID_TO_ALIAS[canonicalProvider] || canonicalProvider;
  const meta = getModelMeta(alias, cleanModel);
  if (typeof meta?.fixedEffort === "string" && meta.fixedEffort.trim()) {
    return meta.fixedEffort.trim().toLowerCase();
  }

  const levels = getThinkingLevels(canonicalProvider, cleanModel);
  if (!levels?.length) return null;
  if (levels.length === 1) return levels[0];

  const upstreamLevel = meta?.upstreamModelId?.match(/\(([^()]+)\)\s*$/)?.[1]?.toLowerCase();
  const idLevel = cleanModel.match(/-(none|minimal|low|medium|high|xhigh|max)$/i)?.[1]?.toLowerCase();
  return upstreamLevel && idLevel === upstreamLevel ? upstreamLevel : null;
}

export function resolveModelEffortSetting(modelOverrides, provider, model, onInvalid = () => {}) {
  const key = getModelEffortKey(provider, model);
  const entry = modelOverrides?.[key];
  if (!entry || entry.effort == null || entry.effort === "") return null;

  const canonicalProvider = resolveProviderAlias(provider);
  const cleanModel = stripThinkingSuffix(model);
  const levels = getThinkingLevels(canonicalProvider, cleanModel);
  const fixed = getFixedEffortLevel(canonicalProvider, cleanModel);
  if (!levels?.includes(entry.effort) || fixed) {
    onInvalid({ key, effort: entry.effort, validChoices: fixed ? ["auto"] : ["auto", ...(levels || [])] });
    return null;
  }
  return { effort: entry.effort, locked: entry.locked === true };
}

export function normalizeThinkingEffort(config) {
  if (!config || typeof config !== "object") return null;
  if (config.mode === "none") return "none";
  if (config.mode === "auto") return "auto";
  if (config.mode === "level" && typeof config.level === "string") return config.level.toLowerCase();
  if (config.mode === "budget" && Number.isFinite(config.budget) && config.budget > 0) {
    if (config.budget <= 768) return "minimal";
    if (config.budget <= 4096) return "low";
    if (config.budget <= 16384) return "medium";
    if (config.budget <= 28672) return "high";
    if (config.budget <= 80384) return "xhigh";
    return "max";
  }
  return null;
}
