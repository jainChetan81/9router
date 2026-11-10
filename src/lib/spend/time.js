// Shared IST (UTC+5:30) day and time bucketing helpers used across Spend and Usage.
export const IST_OFFSET_MS = 5.5 * 3600e3;
export const DAY_MS = 864e5;
export const HOUR_MS = 36e5;

function toEpochMs(ts) {
  if (ts == null) return Date.now();
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : Date.now();
  if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts.getTime() : Date.now();
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

// Returns "YYYY-MM-DD" in IST for a timestamp (ms, Date, ISO string, or omitted = now).
export function istDayKey(ts) {
  return new Date(toEpochMs(ts) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// UTC epoch ms for IST 00:00:00.000 of the IST day containing `ts`.
export function istMidnightMs(ts) {
  const ms = toEpochMs(ts);
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

// Returns "YYYY-MM-DD" in IST for `daysAgo` days before `nowMs` (0 = today IST).
export function istDayKeyOffset(daysAgo = 0, nowMs = Date.now()) {
  return istDayKey(istMidnightMs(nowMs) - daysAgo * DAY_MS);
}

// UTC epoch ms for an IST "YYYY-MM-DD" day key's 00:00:00.000 IST midnight.
export function istDayKeyToMs(dayKey) {
  return Date.parse(dayKey + "T00:00:00Z") - IST_OFFSET_MS;
}

// Formats "Mon D" in IST (e.g. "Nov 9").
export function fmtIstDay(ts) {
  return new Date(toEpochMs(ts) + IST_OFFSET_MS).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Formats "HH:MM" (24-hour) in IST (e.g. "00:00", "23:45").
export function fmtIstHhmm(ts) {
  return new Date(toEpochMs(ts) + IST_OFFSET_MS).toISOString().slice(11, 16);
}
