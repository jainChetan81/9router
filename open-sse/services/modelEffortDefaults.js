import { isCodexResponsesLiteModel, getCodexDefaultEffort } from "../config/codexEffort.js";
import { FORMATS } from "../translator/formats.js";
import { resolveProviderAlias } from "./model.js";
import { normalizeThinkingEffort } from "./modelEffort.js";

export function resolveProviderDefaultEffort({ provider, model, providerThinking, targetFormat, responsesLite } = {}) {
  const mode = providerThinking?.mode;
  if (typeof mode === "string" && mode !== "auto") {
    const normalizedConfig = mode === "on"
      ? { mode: "budget", budget: 10000 }
      : mode === "off"
        ? { mode: "none" }
        : mode === "none"
          ? { mode: "none" }
          : mode === "level" || mode === "budget"
            ? providerThinking
            : { mode: "level", level: mode };
    const effort = normalizeThinkingEffort(normalizedConfig);
    if (effort !== null) return effort;
  }

  const canonicalProvider = resolveProviderAlias(provider);
  // Codex's default is supplied by its Responses executor. A model target
  // format can override that route, so only report the executor default when
  // the target is unspecified or remains on Responses.
  if (canonicalProvider === "codex" && (!targetFormat || targetFormat === FORMATS.OPENAI_RESPONSES)) {
    const lite = typeof responsesLite === "boolean" ? responsesLite : isCodexResponsesLiteModel(model);
    return getCodexDefaultEffort(lite);
  }

  return null;
}
