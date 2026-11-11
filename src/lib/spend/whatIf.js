// Inputs are the same split tokens used for existing Spend totals.
export function estimateMove(tokens, price) {
  const cost = (tokens.input * price.input + tokens.cacheRead * (price.cached ?? price.input) + tokens.cacheWrite * (price.cache_creation ?? price.input) + tokens.output * price.output) / 1_000_000;
  return { cost, delta: cost - tokens.cost };
}
