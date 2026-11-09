// "value" = list-price cost (cost column). Reuse as Spend does.
export function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
export function tokensOf(r) { return (r.promptTokens || 0) + (r.completionTokens || 0); }