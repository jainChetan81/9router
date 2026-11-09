export const HOUR = 3600000;
// Calendar month before the reset (UTC), so 28-31 day months stay exact.
function monthBefore(resetAt) {
  const d = new Date(resetAt);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return resetAt - d.getTime();
}
export function windowLength(name, provider, resetAt = null) {
  const s = String(name || "");
  if (/5h|rolling/i.test(s)) return 5 * HOUR;
  if (/7d|weekly/i.test(s) || (provider === "codex" && /week/i.test(s))) return 7 * 24 * HOUR;
  if (/monthly/i.test(s)) return Number.isFinite(resetAt) ? monthBefore(resetAt) : null;
  return null;
}
export function forecastQuota({ usedPct, resetAt, windowMs, now = Date.now() }) {
  if (usedPct == null || !Number.isFinite(Number(usedPct))) return { projectedPct: null, runsOutAt: null };
  if (!windowMs || !resetAt || resetAt <= now) return { projectedPct: null, runsOutAt: null };
  const elapsed = windowMs - (Number(resetAt) - now);
  if (elapsed <= 10 * 60 * 1000 || elapsed > windowMs) return { projectedPct: null, runsOutAt: null };
  const rate = Number(usedPct) / elapsed;
  if (rate === 0) return { projectedPct: 0, runsOutAt: null };
  const projectedPct = rate * windowMs;
  const out = rate > 0 ? now + (100 - Number(usedPct)) / rate : null;
  return { projectedPct, runsOutAt: out != null && out < Number(resetAt) ? out : null };
}
export function quotaRisk(usedPct, projectedPct) {
  if (usedPct == null) return "unknown";
  if (usedPct >= 90 || (projectedPct != null && projectedPct >= 100)) return "high";
  if (usedPct >= 70 || (projectedPct != null && projectedPct >= 85)) return "warn";
  return "ok";
}
export function normalizeQuotaRow({ provider, name, quota, now = Date.now() }) {
  const total = Number(quota?.total ?? quota?.limit ?? 0);
  const used = Number(quota?.used ?? quota?.usage ?? 0);
  const limitKnown = quota?.unlimited !== true && total > 0;
  const usedPct = limitKnown ? used / total * 100 : null;
  const resetAt = quota?.resetAt ? (typeof quota.resetAt === "number" ? quota.resetAt : Date.parse(quota.resetAt)) : null;
  const window = quota?.name || quota?.label || quota?.window || "Unknown";
  const windowMs = windowLength(window, provider, resetAt);
  const forecast = forecastQuota({ usedPct, resetAt, windowMs, now });
  return { provider, name, window, used, usedPct, resetAt: Number.isFinite(resetAt) ? resetAt : null, windowMs, ...forecast, risk: quotaRisk(usedPct, forecast.projectedPct), limitKnown };
}
export function sortQuotaRows(rows) {
  const rank = { high: 0, warn: 1, ok: 2, unknown: 3 };
  return rows.sort((a, b) => (rank[a.risk] ?? 4) - (rank[b.risk] ?? 4) || (b.usedPct ?? -1) - (a.usedPct ?? -1));
}
