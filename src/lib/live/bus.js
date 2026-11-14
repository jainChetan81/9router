// STUB of the live bus (work package 1 owns the real file and replaces this one at merge).
// Contract: bump(topic, payload?), version(topic), subscribe(fn) -> unsubscribe.
// Topics: "usage", "agents", "pii", "quota". A version is an integer that only grows within one process.
const KEY = "__nineRouterLiveBus";
const state = (globalThis[KEY] ||= { versions: new Map(), listeners: new Set() });

export function version(topic) { return state.versions.get(topic) || 0; }

export function bump(topic, payload) {
  const v = version(topic) + 1;
  state.versions.set(topic, v);
  for (const fn of state.listeners) { try { fn({ topic, v, data: payload }); } catch {} }
  return v;
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => { state.listeners.delete(fn); };
}
