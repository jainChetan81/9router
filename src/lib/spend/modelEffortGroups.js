export function addModelEffortUsage(groups, { model, effort, cost, real, realEst = 0, tokens }) {
  const modelId = model || "unknown";
  const level = typeof effort === "string" && effort ? effort : "Unknown";
  const key = JSON.stringify([modelId, level]);
  let group = groups.get(key);
  if (!group) {
    group = { k: `${modelId} · ${level}`, model: modelId, effort: level, v: 0, real: 0, realEst: 0, req: 0, tok: 0 };
    groups.set(key, group);
  }
  group.v += cost;
  group.real += real;
  group.realEst += Number(realEst) || 0;
  group.req += 1;
  group.tok += tokens;
  return group;
}
