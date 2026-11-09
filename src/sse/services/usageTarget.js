import { getProviderNodes, getCustomModels, getComboByName } from "@/lib/localDb";
import { getModelInfo } from "./model.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { isValidModel } from "open-sse/config/providerModels.js";

function registryProvider(provider) {
  return REGISTRY.find((entry) =>
    entry.id === provider || entry.alias === provider || (entry.aliases || []).includes(provider)
  ) || null;
}

export async function resolveSafeUsageTarget(modelStr, modelInfo = null) {
  if (typeof modelStr !== "string" || !modelStr.trim()) return { provider: null, model: "invalid" };
  const requested = modelStr.trim();

  if (!modelInfo) {
    try {
      if (!requested.includes("/") && await getComboByName(requested)) {
        return { provider: null, model: requested };
      }
    } catch { /* continue with provider model validation */ }
  }

  let resolved = modelInfo;
  try { resolved ||= await getModelInfo(requested); } catch { /* keep the sentinel below */ }
  const provider = typeof resolved?.provider === "string" ? resolved.provider : null;
  const model = typeof resolved?.model === "string" ? resolved.model : null;
  const entry = provider ? registryProvider(provider) : null;
  let providerNode = null;
  if (provider && !entry) {
    try { providerNode = (await getProviderNodes()).find((node) => node.id === provider) || null; } catch {}
  }

  const providerAliases = new Set([provider].filter(Boolean));
  if (entry) {
    providerAliases.add(entry.id);
    if (entry.alias) providerAliases.add(entry.alias);
    for (const alias of entry.aliases || []) providerAliases.add(alias);
  }
  if (providerNode) {
    providerAliases.add(providerNode.id);
    if (providerNode.prefix) providerAliases.add(providerNode.prefix);
  }

  let knownModel = false;
  if (model && entry) {
    knownModel = [...providerAliases].some((alias) => isValidModel(alias, model));
  }
  if (model && !knownModel) {
    try {
      const customModels = await getCustomModels();
      knownModel = customModels.some((custom) =>
        custom.id === model && providerAliases.has(custom.providerAlias)
      );
    } catch { /* custom catalog lookup is best-effort */ }
  }

  return {
    provider: entry?.id || providerNode?.id || null,
    model: knownModel ? model : "invalid",
  };
}
