// Inputs are the same split tokens used for existing Spend totals. The rates
// and fallbacks match calculateCostFromTokens() in open-sse/providers/pricing.js.
export function estimateMove(tokens, price) {
  const cost = (
    tokens.input * price.input +
    tokens.cacheRead * (price.cached || price.input) +
    tokens.cacheWrite * (price.cache_creation || price.input) +
    tokens.output * price.output +
    (tokens.reasoning || 0) * (price.reasoning || price.output)
  ) / 1_000_000;
  return { cost, delta: cost - tokens.cost };
}
