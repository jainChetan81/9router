/**
 * Live bus for multiplexed change notifications across 9Router subsystems.
 * Topics: "usage", "agents", "pii", "quota".
 * Versions are monotonically increasing integers per topic per process.
 */

if (!global._liveBus) {
  global._liveBus = {
    versions: {},
    subscribers: new Set(),
    coalesceTimers: {},
    latestPayloads: {},
  };
}

const bus = global._liveBus;

/**
 * Bump version for a topic and notify subscribers.
 * Monotonically increments version counter for the topic.
 *
 * @param {string} topic - e.g. "usage", "agents", "pii", "quota"
 * @param {any} [payload] - optional in-memory data (counters/ids only)
 * @returns {number} new version
 */
export function bump(topic, payload) {
  if (!topic || typeof topic !== "string") return 0;
  bus.versions[topic] = (bus.versions[topic] || 0) + 1;
  const v = bus.versions[topic];
  const event = payload !== undefined ? { topic, v, data: payload } : { topic, v };

  for (const fn of bus.subscribers) {
    try {
      fn(event);
    } catch (err) {
      console.error(`[liveBus] subscriber error on ${topic}:`, err);
    }
  }
  return v;
}

/**
 * Coalesced bump: delays bump by delayMs and collapses rapid calls,
 * keeping the latest payload.
 *
 * @param {string} topic
 * @param {any} [payload]
 * @param {number} [delayMs=250]
 */
export function bumpCoalesced(topic, payload, delayMs = 250) {
  if (!topic || typeof topic !== "string") return;
  if (payload !== undefined) {
    bus.latestPayloads[topic] = payload;
  }
  if (bus.coalesceTimers[topic]) return;

  bus.coalesceTimers[topic] = setTimeout(() => {
    bus.coalesceTimers[topic] = null;
    const data = bus.latestPayloads[topic];
    delete bus.latestPayloads[topic];
    bump(topic, data);
  }, delayMs);
  bus.coalesceTimers[topic]?.unref?.();
}

/**
 * Current version for a topic.
 *
 * @param {string} topic
 * @returns {number}
 */
export function version(topic) {
  return bus.versions[topic] || 0;
}

/**
 * Subscribe to topic change events.
 *
 * @param {(event: { topic: string, v: number, data?: any }) => void} fn
 * @returns {() => void} unsubscribe function
 */
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  bus.subscribers.add(fn);
  return () => {
    bus.subscribers.delete(fn);
  };
}

/**
 * Reset bus state (primarily for tests).
 */
export function reset() {
  for (const key of Object.keys(bus.coalesceTimers)) {
    if (bus.coalesceTimers[key]) clearTimeout(bus.coalesceTimers[key]);
  }
  bus.versions = {};
  bus.subscribers.clear();
  bus.coalesceTimers = {};
  bus.latestPayloads = {};
}
