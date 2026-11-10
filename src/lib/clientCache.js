// Browser-side cache for dashboard API responses. Module memory survives
// client-side navigation between dashboard pages; a session-storage mirror
// survives a reload in the same tab. Stale-while-revalidate is up to callers:
// they read `at` and decide whether to refetch.

const MAX_ENTRIES = 30;
const STORE_KEY = "r9-cache:";
const mem = new Map(); // key -> { data, at }, oldest first

function storage() {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

function touch(key, entry) {
  mem.delete(key);
  mem.set(key, entry);
  while (mem.size > MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    mem.delete(oldest);
    try { storage()?.removeItem(STORE_KEY + oldest); } catch { /* storage blocked */ }
  }
}

/** Returns `{ data, at }` or null. */
export function cacheGet(key) {
  if (!key) return null;
  const hit = mem.get(key);
  if (hit) return hit;
  try {
    const raw = storage()?.getItem(STORE_KEY + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.at !== "number") return null;
    touch(key, entry);
    return entry;
  } catch { return null; }
}

export function cacheSet(key, data, at = Date.now()) {
  if (!key) return;
  const entry = { data, at };
  touch(key, entry);
  try { storage()?.setItem(STORE_KEY + key, JSON.stringify(entry)); } catch { /* quota or blocked */ }
}

/** Removes every entry whose key starts with `prefix`. */
export function cacheInvalidate(prefix) {
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
  const s = storage();
  if (!s) return;
  try {
    const drop = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(STORE_KEY + prefix)) drop.push(k); }
    drop.forEach((k) => s.removeItem(k));
  } catch { /* storage blocked */ }
}

/** True when the entry exists and is younger than `ttlMs`. */
export const isFresh = (entry, ttlMs, now = Date.now()) => !!entry && now - entry.at < ttlMs;

/** "just now", "4 min ago", "2 h ago". */
export function updatedAgo(at, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "Updated just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  return `Updated ${Math.floor(m / 60)} h ago`;
}

export const _test = { reset: () => mem.clear(), size: () => mem.size, MAX_ENTRIES };
