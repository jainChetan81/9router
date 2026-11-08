const HYPHEN_EFFORT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max)$/i;

// Split an explicit model effort suffix without deciding whether a hyphen
// suffix is a preset ID or a real registry model. Callers validate that case.
export function parseModelEffortSuffix(model, { allowHyphen = false } = {}) {
  if (typeof model !== "string") {
    return { cleanModel: model, suffix: null, suffixText: "", syntax: null };
  }

  const parenthesized = model.match(/^(.*)\(([^()]+)\)\s*$/);
  if (parenthesized) {
    return {
      cleanModel: parenthesized[1].trim(),
      suffix: parenthesized[2].trim().toLowerCase(),
      suffixText: parenthesized[0].slice(parenthesized[1].length).trim(),
      syntax: "parenthesized",
    };
  }

  const hyphenated = allowHyphen ? model.match(HYPHEN_EFFORT_SUFFIX) : null;
  if (hyphenated) {
    return {
      cleanModel: model.slice(0, hyphenated.index),
      suffix: hyphenated[1].toLowerCase(),
      suffixText: `(${hyphenated[1].toLowerCase()})`,
      syntax: "hyphenated",
    };
  }

  return { cleanModel: model, suffix: null, suffixText: "", syntax: null };
}
