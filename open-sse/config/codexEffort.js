import { getProviderModels } from "./providerModels.js";

export function isCodexResponsesLiteModel(model) {
  const baseId = String(model || "").replace(/\([^()]+\)\s*$/, "");
  return getProviderModels("cx").some((entry) => entry.id === baseId && entry.responsesLite === true);
}

export function getCodexDefaultEffort(responsesLite) {
  return responsesLite ? "medium" : "low";
}
