import { OPENCODE_GO_PACING, OPENCODE_GO_PACING_SLACK_PCT } from "../config/runtimeConfig.js";
import { getOpenCodeGoUsage } from "./usage/opencode-go.js";

const REFRESH_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const WEEK_MS = 7 * DAY_MS;
const ROLLING_CAP_PCT = 95;

// Fraction of the week elapsed since Monday 00:00 UTC.
function weekElapsedFraction(nowMs) {
  const d = new Date(nowMs);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  return Math.min(1, Math.max(0, (nowMs - start) / WEEK_MS));
}

// Fraction of a 30-day period elapsed, derived from its reset time.
function monthElapsedFraction(resetAt, nowMs) {
  const end = Date.parse(resetAt);
  if (!Number.isFinite(end)) return null;
  return Math.min(1, Math.max(0, (nowMs - (end - MONTH_MS)) / MONTH_MS));
}

// Returns a reason string when usage is ahead of pace, else null.
export function evaluatePacing(quotas, nowMs, slackPct) {
  if (!quotas) return null;
  const rolling = quotas.Rolling?.used;
  if (typeof rolling === "number" && rolling >= ROLLING_CAP_PCT) return `rolling ${rolling}% >= ${ROLLING_CAP_PCT}%`;
  const weekly = quotas.Weekly?.used;
  if (typeof weekly === "number") {
    const allowed = weekElapsedFraction(nowMs) * 100 + slackPct;
    if (weekly > allowed) return `weekly ${weekly}% > pace ${allowed.toFixed(1)}%`;
  }
  const monthly = quotas.Monthly?.used;
  if (typeof monthly === "number" && quotas.Monthly.resetAt) {
    const frac = monthElapsedFraction(quotas.Monthly.resetAt, nowMs);
    if (frac !== null) {
      const allowed = frac * 100 + slackPct;
      if (monthly > allowed) return `monthly ${monthly}% > pace ${allowed.toFixed(1)}%`;
    }
  }
  return null;
}

async function defaultGetKey() {
  const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
  const conns = await getProviderConnections({ provider: "opencode-go", isActive: true });
  return conns.find((c) => c.apiKey)?.apiKey || null;
}

export function createGoPacing({
  fetchUsage = getOpenCodeGoUsage,
  getKey = defaultGetKey,
  now = Date.now,
  enabled = () => OPENCODE_GO_PACING,
  slackPct = () => OPENCODE_GO_PACING_SLACK_PCT,
} = {}) {
  let snapshot = null; // { quotas, at }
  let inflight = null;

  async function refresh() {
    try {
      const key = await getKey();
      if (!key) return null;
      const usage = await fetchUsage(key);
      return usage?.quotas ? { quotas: usage.quotas, at: now() } : null;
    } catch {
      return null;
    }
  }

  async function getSnapshot() {
    if (snapshot && now() - snapshot.at < REFRESH_MS) return snapshot;
    if (!inflight) {
      inflight = refresh().finally(() => { inflight = null; });
    }
    const fresh = await inflight;
    if (fresh) snapshot = fresh;
    return snapshot;
  }

  // True when the member should be skipped. Any failure means "do not skip".
  async function shouldSkip(log) {
    if (!enabled()) return false;
    try {
      const snap = await getSnapshot();
      const reason = evaluatePacing(snap?.quotas, now(), slackPct());
      if (reason) log?.debug?.("COMBO", `Skipping opencode-go member, ahead of pace: ${reason}`);
      return !!reason;
    } catch {
      return false;
    }
  }

  return { shouldSkip, _reset() { snapshot = null; inflight = null; } };
}

export const openCodeGoPacing = createGoPacing();
