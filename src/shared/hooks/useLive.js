"use client";
// STUB of the live hook (work package 1 owns the real file and replaces this one at merge).
// Contract: useLiveTopic(topic, { throttleMs }) -> { version, connected }. The real hook shares one
// EventSource on /api/live per tab and bumps `version` when the topic changes; consumers refetch then.
// This stub never connects, so a page behaves as it did before: manual sync and the fallback timer.
export function useLiveTopic(_topic, _options) {
  return { version: 0, connected: false };
}
