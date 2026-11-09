// In-memory cache with TTL
const store = new Map();
const MAX_CACHE_ENTRIES = 100;
export function cacheGet(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { store.delete(key); return undefined; }
  store.delete(key);
  store.set(key, e);
  return e.val;
}
export function cacheSet(key, val, ttlMs) {
  const now = Date.now();
  for (const [entryKey, entry] of store) {
    if (now > entry.exp) store.delete(entryKey);
  }
  store.delete(key);
  store.set(key, { val, exp: now + ttlMs });
  while (store.size > MAX_CACHE_ENTRIES) {
    store.delete(store.keys().next().value);
  }
}
export function cacheClear(key) { if (key) store.delete(key); else store.clear(); }
