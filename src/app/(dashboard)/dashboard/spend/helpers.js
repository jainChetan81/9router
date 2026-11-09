// Pure helpers for the Spend and Agents pages. No DOM, no fetch.

// A fee draft is valid when it is empty (not set) or a finite number >= 0.
export function feeError(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (s === "") return "";
  if (/^-\s*(\d|\.\d)/.test(s)) return "Fees cannot be negative.";
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return "Enter a number, 0 or more.";
  const n = Number(s);
  if (!Number.isFinite(n)) return "Enter a number, 0 or more.";
  return "";
}

// True when every draft value passes feeError. Empty values are allowed (they clear the fee).
export function feesValid(draft) {
  return Object.values(draft || {}).every((v) => !feeError(v));
}

// Short custom-range label: "Nov 5–8", "Nov 28 – Dec 2", or a single date.
export function shortRange(from, to) {
  const a = from instanceof Date ? from : new Date(from + "T00:00:00");
  const b = to instanceof Date ? to : new Date(to + "T00:00:00");
  const mon = (d) => d.toLocaleDateString("en-US", { month: "short" });
  if (a.getTime() === b.getTime()) return mon(a) + " " + a.getDate();
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return mon(a) + " " + a.getDate() + "–" + b.getDate();
  return mon(a) + " " + a.getDate() + " – " + mon(b) + " " + b.getDate();
}

// Axis tick step: fewer labels on narrow screens so they do not overlap (S2).
export function tickStep(count, { hourly = false, narrow = false } = {}) {
  if (narrow && !hourly) return count >= 14 ? 7 : Math.max(1, Math.ceil(count / 5));
  return Math.max(1, Math.ceil(count / (hourly ? 12 : 10)));
}

// Timeline window end is never later than now (A18). Returns [start, end].
export function clampWindow(start, len, now, lastReq) {
  let end = start + len;
  if (end > now && now >= lastReq) return [now - len, now];
  return [start, end];
}

// Nearest-session selection: keep the current id if it is still listed (A15, A16).
export function pickSelection(current, listed) {
  if (current && listed.includes(current)) return current;
  return null;
}
