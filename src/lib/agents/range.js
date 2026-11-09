// Range resolution copied from src/app/api/spend/route.js (IST bucketing).
const IST = 5.5 * 3600e3;
const DAY = 864e5;
const PRESET_DAYS = { "7D": 7, "30D": 30, "60D": 60 };
const DAYKEY = /^\d{4}-\d{2}-\d{2}$/;

export const IST_OFFSET = IST;
export const DAY_MS = DAY;

export function istMidnight(ms) { return Math.floor((ms + IST) / DAY) * DAY - IST; }
export function dayKey(ms) { return new Date(ms + IST).toISOString().slice(0, 10); }

export function resolveRange(params, now, firstMs) {
  const preset = params.get("preset") || "30D";
  const today0 = istMidnight(now);
  if (preset === "Today") return { preset, hourly: true, from: today0, to: today0 + DAY };
  if (preset === "24h") { const end = Math.floor(now / 36e5) * 36e5 + 36e5; return { preset, hourly: true, from: end - DAY, to: end }; }
  if (preset === "Custom") {
    const f = params.get("from"), t = params.get("to");
    if (DAYKEY.test(f || "") && DAYKEY.test(t || "") && !Number.isNaN(Date.parse(f)) && !Number.isNaN(Date.parse(t))) {
      const a = Date.parse(f + "T00:00:00Z") - IST, b = Date.parse(t + "T00:00:00Z") - IST + DAY;
      if (b > a && a <= today0 && b - a <= 400 * DAY) return { preset, hourly: false, from: a, to: Math.min(b, today0 + DAY) };
    }
  }
  if (preset === "All") return { preset, hourly: false, from: istMidnight(Math.min(firstMs || now, now)), to: today0 + DAY };
  const n = PRESET_DAYS[preset] || 30;
  return { preset: PRESET_DAYS[preset] ? preset : "30D", hourly: false, from: today0 - (n - 1) * DAY, to: today0 + DAY };
}

export async function distinctFirstMs(db) {
  const r = db.get("SELECT MIN(timestamp) AS t FROM usageHistory");
  return r?.t ? Date.parse(r.t) : Date.now();
}