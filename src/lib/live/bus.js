// Live topic bus — WP2 STUB of the WP1 contract. WP1 owns this file; its
// version replaces this one at merge. Same exports, same meaning:
//   bump(topic, payload?)  raise the topic's version and notify subscribers
//   version(topic)         current version (monotonic integer per process)
//   subscribe(fn)          fn({ topic, v, data }) on every bump; returns unsubscribe
// Topics: "usage", "agents", "pii", "quota". No DB reads, no timers.
const BUS_KEY = Symbol.for("9router.live.bus");
const state = globalThis[BUS_KEY] || (globalThis[BUS_KEY] = { versions: new Map(), subscribers: new Set() });

export function version(topic) {
  return state.versions.get(topic) || 0;
}

export function bump(topic, payload) {
  const v = version(topic) + 1;
  state.versions.set(topic, v);
  for (const fn of [...state.subscribers]) {
    try { fn({ topic, v, data: payload }); } catch { /* one bad subscriber must not stop the rest */ }
  }
  return v;
}

export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  state.subscribers.add(fn);
  return () => { state.subscribers.delete(fn); };
}
