export const PAID = (provider) => provider === "openrouter" || provider === "deepseek";

function parsedTokens(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
}

export function splitTokens(raw, promptFallback = 0, completionFallback = 0) {
  const t = parsedTokens(raw);
  const first = (...values) => values.find((v) => Number.isFinite(Number(v)) && v !== null && v !== "");
  const prompt = Number(first(t.prompt_tokens, t.input_tokens, promptFallback) ?? 0);
  const output = Number(first(t.completion_tokens, t.output_tokens, completionFallback) ?? 0);
  const cacheRead = Math.max(0, Number(first(t.cached_tokens, t.cache_read_input_tokens) ?? 0));
  const cacheWrite = Math.max(0, Number(first(t.cache_creation_input_tokens) ?? 0));
  return { input: Math.max(0, prompt - cacheRead - cacheWrite), cacheRead, cacheWrite, output: Math.max(0, output) };
}

const node = () => ({ v: 0, real: 0, req: 0, tok: 0, tokSplit: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
function feed(target, row, split) {
  target.v += Number(row.cost) || 0;
  target.real += Number(row.real) || 0;
  target.req += 1;
  target.tok += Object.values(split).reduce((a, v) => a + v, 0);
  for (const k of Object.keys(split)) target.tokSplit[k] += split[k];
}
export function createSpendDrilldown() {
  const providers = new Map(), modelSplits = new Map(), routes = new Map();
  return {
    add(row) {
      const split = splitTokens(row.tokens, row.promptTokens, row.completionTokens);
      const provider = row.provider || "unknown", model = row.model || "unknown";
      let p = providers.get(provider); if (!p) providers.set(provider, p = { ...node(), models: new Map() });
      feed(p, row, split);
      let m = p.models.get(model); if (!m) p.models.set(model, m = { ...node(), efforts: new Map() });
      feed(m, row, split);
      const effort = typeof row.effort === "string" && row.effort ? row.effort : "Unknown";
      let e = m.efforts.get(effort); if (!e) m.efforts.set(effort, e = node()); feed(e, row, split);
      let total = modelSplits.get(model); if (!total) modelSplits.set(model, total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      for (const k of Object.keys(split)) total[k] += split[k];
      if (row.client != null) {
        const combo = row.role || "main";
        const edges = [[`combo:${combo}`, `provider:${provider}`], [`provider:${provider}`, `model:${provider}:${model}`]];
        for (const [source, target] of edges) {
          const key = JSON.stringify([source, target]); let l = routes.get(key);
          if (!l) routes.set(key, l = { source, target, req: 0, v: 0, real: 0, paid: PAID(provider) });
          l.req++; l.v += Number(row.cost) || 0; l.real += Number(row.real) || 0;
        }
      }
    },
    result() {
      const sortValue = (a, b) => b.v - a.v;
      const providerTree = [...providers].map(([k, p]) => ({ k, ...p, models: [...p.models].map(([mk, m]) => ({ k: mk, ...m, efforts: [...m.efforts].map(([ek, v]) => ({ k: ek, ...v })).sort(sortValue) })).sort(sortValue) })).sort(sortValue);
      const routeNodes = new Map();
      for (const link of routes.values()) {
        const sourceKind = link.source.startsWith("combo:") ? "combo" : "provider";
        const targetKind = link.target.startsWith("provider:") ? "provider" : "model";
        routeNodes.set(link.source, { id: link.source, kind: sourceKind });
        routeNodes.set(link.target, { id: link.target, kind: targetKind });
      }
      const links = [...routes.values()];
      const modelReq = new Map();
      for (const link of links) if (link.target.startsWith("model:")) modelReq.set(link.source, (modelReq.get(link.source) || 0) + link.req);
      const mergeTargets = new Map();
      for (const [providerId, count] of modelReq) {
        const models = links.filter((link) => link.source === providerId && link.target.startsWith("model:")).sort((a, b) => b.req - a.req);
        for (const link of models.slice(25)) {
          const otherId = `${providerId}:other-models`;
          let aggregate = mergeTargets.get(otherId);
          if (!aggregate) mergeTargets.set(otherId, aggregate = { source: providerId, target: otherId, req: 0, v: 0, real: 0, paid: link.paid });
          aggregate.req += link.req; aggregate.v += link.v; aggregate.real += link.real;
          links.splice(links.indexOf(link), 1);
          routeNodes.delete(link.target);
        }
        if (mergeTargets.has(`${providerId}:other-models`)) routeNodes.set(`${providerId}:other-models`, { id: `${providerId}:other-models`, kind: "model" });
      }
      links.push(...mergeTargets.values());
      const tokenSplit = Object.fromEntries(modelSplits);
      const totalSplit = Object.values(tokenSplit).reduce((a, x) => { for (const k of Object.keys(a)) a[k] += x[k]; return a; }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      return { providerTree, tokenSplit, totalSplit, routes: { nodes: [...routeNodes.values()], links } };
    },
  };
}

export function buildRoutes(rows) {
  const acc = createSpendDrilldown(); for (const row of rows) acc.add(row); return acc.result().routes;
}
