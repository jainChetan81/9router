// Refetch policy for the Agents page, kept free of React so it can be tested.
//
// The page refetches for three reasons: a live topic version changed (pushed
// by /api/live), the fallback sync timer fired, or the user asked. The first
// two are automatic and stop while the page is paused or the tab is hidden.

/** Fallback auto-sync interval for Agents when no interval is saved (seconds). */
export const AGENTS_SYNC_FALLBACK_S = 60;
/** Minimum gap between two automatic /live fetches. */
export const LIVE_THROTTLE_MS = 2000;
/** Minimum gap between two automatic range (sessions, analytics, tools) fetches. */
export const RANGE_THROTTLE_MS = 60_000;

/** Automatic fetches of any kind are allowed. */
export function autoAllowed({ paused, hidden }) {
  return !paused && !hidden;
}

/** A live topic change may refetch /api/agents/live: only on the Live tab. */
export function liveAutoAllowed({ paused, hidden, tab }) {
  return autoAllowed({ paused, hidden }) && tab === "live";
}

/** Which range data the current view shows. Only these are fetched. */
export function rangeNeeds({ tab, drawer }) {
  return {
    // The details drawer reads session totals, also when opened from Live.
    sessions: tab === "sessions" || !!drawer,
    analytics: tab === "roles",
    tools: tab === "tools",
  };
}

/**
 * Throttled refetch trigger.
 *   request()  automatic trigger. Skipped while `allowed()` is false. Runs at
 *              once when the last run is older than `throttleMs`, otherwise
 *              once more when the throttle window ends (re-checking `allowed`).
 *   force()    user trigger. Runs now, whatever `allowed()` says.
 *   cancel()   drop a pending trailing run.
 */
export function createRefetcher({ run, throttleMs = 0, allowed = () => true, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lastRun = -Infinity;
  let timer = null;
  const fire = () => { lastRun = now(); run(); };
  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    request() {
      if (!allowed()) return false;
      const wait = throttleMs - (now() - lastRun);
      if (wait <= 0) { cancel(); fire(); return true; }
      if (timer === null) {
        timer = setTimer(() => { timer = null; if (allowed()) fire(); }, wait);
      }
      return false;
    },
    force() { cancel(); fire(); },
    cancel,
    pending: () => timer !== null,
  };
}

/** Seconds for the fallback timer: the saved choice, else the Agents fallback. */
export function agentsSyncSeconds(dashboardSync, choices) {
  const saved = dashboardSync?.agents;
  return choices.includes(saved) ? saved : AGENTS_SYNC_FALLBACK_S;
}

/**
 * Freshness line under the header. `okAt` is the time of the last successful
 * fetch for the current view (null before the first one), `failed` is true
 * when the latest fetch failed.
 */
export function freshnessOf({ okAt, failed = false, paused = false, now = Date.now() }) {
  const age = Number.isFinite(okAt) ? Math.max(0, Math.floor((now - okAt) / 1000)) : null;
  const ago = age == null ? "not loaded yet"
    : age < 5 ? "updated just now"
    : age < 60 ? `updated ${age} s ago`
    : age < 3600 ? `updated ${Math.floor(age / 60)} min ago`
    : `updated ${Math.floor(age / 3600)} h ago`;
  const cap = (text) => text[0].toUpperCase() + text.slice(1);
  if (paused) return { state: "paused", text: "Paused · " + ago, icon: "play_arrow", btn: "Resume" };
  if (failed) return { state: "error", text: "Update failed · " + (age == null ? "no data yet" : "last " + ago), icon: "pause", btn: "Pause" };
  return { state: age == null ? "loading" : "ok", text: age == null ? "Loading…" : cap(ago), icon: "pause", btn: "Pause" };
}

/** Clock time in IST for tooltips, e.g. "18:47:05 IST". */
export function istClock(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }) + " IST";
}
