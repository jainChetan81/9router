// Per-page auto-sync settings for the dashboard (seconds; 0 = off).
// Stored in settings.dashboardSync and shared by every browser.

// "Sync now" (and the auto-sync timer) asks for fresh data with this request
// header. Cached data is the default everywhere; a request that carries the
// header skips every cache on its way: no conditional request from the
// client, no 304, no server result cache, no stale-while-revalidate answer.
// Background refetches (live topics, page load) never send it.
export const SYNC_HEADER = "x-9r-sync";

/** Fetch headers for a load: the sync header when `sync`, else none. */
export function syncHeaders(sync) {
  return sync ? { [SYNC_HEADER]: "1" } : undefined;
}

/** True when the request was made by "Sync now" or the auto-sync timer. */
export function isSyncRequest(request) {
  try { return request?.headers?.get?.(SYNC_HEADER) === "1"; } catch { return false; }
}

export const SYNC_PAGES = ["agents", "spend", "piiGuard", "quota"];
export const SYNC_CHOICES = [0, 10, 30, 60, 300, 900];
// Agents gets its live data from the /api/live stream; the timer is only a fallback.
export const SYNC_DEFAULTS = { agents: 60, spend: 0, piiGuard: 0, quota: 0 };

/** Keeps known pages with allowed values. Returns null when nothing valid is left. */
export function sanitizeDashboardSync(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const page of SYNC_PAGES) {
    if (!Object.prototype.hasOwnProperty.call(input, page)) continue;
    const v = Number(input[page]);
    if (!SYNC_CHOICES.includes(v)) return null;
    out[page] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function syncSecondsFor(settings, page) {
  const v = settings?.dashboardSync?.[page];
  return SYNC_CHOICES.includes(v) ? v : SYNC_DEFAULTS[page] ?? 0;
}

export function syncLabel(sec) {
  if (!sec) return "Off";
  return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}

/** Countdown for a page's auto-sync, kept outside React so the 1 s tick reaches only its subscribers
 *  (the Sync button) and never re-renders the page. It counts to a deadline, not ticks: no timer runs
 *  while the tab is hidden, and a tab that comes back past the deadline syncs at once.
 *  `hidden()` reports whether the tab is hidden; call `visibility()` when that changes. */
export function createCountdown({ onFire, hidden = () => false, now = Date.now } = {}) {
  let seconds = 0, deadline = 0, left = 0, timer = null;
  const subs = new Set();
  const set = (value) => {
    if (value === left) return;
    left = value;
    for (const fn of [...subs]) fn();
  };
  const arm = () => { deadline = now() + seconds * 1000; set(seconds); };
  const tick = () => {
    const next = Math.ceil((deadline - now()) / 1000);
    if (next > 0) { set(next); return; }
    arm();
    onFire?.();
  };
  const pause = () => { clearInterval(timer); timer = null; };
  const run = () => { if (!timer && seconds > 0 && !hidden()) timer = setInterval(tick, 1000); };
  return {
    getLeft: () => left,
    getSeconds: () => seconds,
    /** Replaces the callback; the hook does this after each render so the newest one runs. */
    setOnFire(fn) { onFire = fn; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    /** Sets the interval (0 = off) and starts over. */
    setSeconds(next) {
      pause();
      seconds = Number(next) > 0 ? Number(next) : 0;
      if (seconds) { arm(); run(); } else set(0);
    },
    /** After a manual sync: the next automatic one is a full interval away. */
    restart() { if (seconds) arm(); },
    visibility() {
      if (hidden()) { pause(); return; }
      if (!seconds) return;
      tick(); // stale: fires now
      run();
    },
    stop() { pause(); },
  };
}
