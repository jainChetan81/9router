// Per-page auto-sync settings for the dashboard (seconds; 0 = off).
// Stored in settings.dashboardSync and shared by every browser.

export const SYNC_PAGES = ["agents", "spend", "piiGuard", "quota"];
export const SYNC_CHOICES = [0, 10, 30, 60, 300, 900];
export const SYNC_DEFAULTS = { agents: 10, spend: 0, piiGuard: 0, quota: 0 };

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
