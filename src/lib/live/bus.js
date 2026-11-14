// Live-data bus (WP1 owns the real implementation; this is the interim stub
// with the same exports). Topics: "usage", "agents", "pii", "quota".
// bump(topic) invalidates a topic; version(topic) returns a per-process
// monotonically increasing integer; subscribe(fn) returns an unsubscribe.
const versions = Object.fromEntries(["usage", "agents", "pii", "quota"].map((t) => [t, 0]));
const subscribers = new Set();

export function bump(topic, payload) {
  if (!(topic in versions)) versions[topic] = 0;
  versions[topic]++;
  for (const fn of subscribers) {
    try { fn(topic, versions[topic], payload); } catch { /* a bad listener must not break the bus */ }
  }
  return versions[topic];
}

export function version(topic) {
  return versions[topic] ?? 0;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
