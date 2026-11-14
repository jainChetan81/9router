"use client";
// Live topic hook — WP2 STUB of the WP1 contract. WP1 owns this file; its
// version replaces this one at merge.
//   useLiveTopic(topic, { throttleMs }) -> { version, connected }
// One shared EventSource("/api/live") per tab, closed while the tab is hidden
// and reopened when it is visible again (every topic's version then moves, so
// pages refetch). If /api/live is missing the stream stays closed and
// `connected` is false; pages fall back to their sync timer.
import { useEffect, useRef, useState } from "react";

const listeners = new Set(); // fn(topic | null); null = every topic
const versions = new Map();
let source = null;
let connected = false;
let epoch = 0; // added to versions after a reconnect so they still move forward

function emit(topic) { for (const fn of [...listeners]) fn(topic); }

function open() {
  if (source || typeof EventSource === "undefined" || document.hidden) return;
  const es = new EventSource("/api/live");
  source = es;
  es.onopen = () => { connected = true; emit(null); };
  es.onerror = () => {
    connected = false;
    // A closed stream (404, auth failure) does not come back by itself.
    if (es.readyState === 2 && source === es) source = null;
    emit(null);
  };
  es.addEventListener("v", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (typeof msg?.topic !== "string") return;
      versions.set(msg.topic, epoch + (Number(msg.v) || 0));
      emit(msg.topic);
    } catch { /* ignore a malformed event */ }
  });
}

function close() {
  if (!source) return;
  source.close();
  source = null;
  connected = false;
}

function onVisibility() {
  if (document.hidden) { close(); emit(null); return; }
  // Data may have changed while hidden: move every version, then reconnect.
  epoch += 1_000_000;
  for (const topic of versions.keys()) versions.set(topic, epoch);
  open();
  emit(null);
}

function attach(fn) {
  if (!listeners.size) {
    document.addEventListener("visibilitychange", onVisibility);
    open();
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    }
  };
}

export function useLiveTopic(topic, { throttleMs = 0 } = {}) {
  const [state, setState] = useState({ version: 0, connected: false });
  const last = useRef(0);
  useEffect(() => {
    let timer = null;
    const read = () => {
      timer = null;
      last.current = Date.now();
      const next = { version: versions.get(topic) ?? epoch, connected };
      setState((old) => (old.version === next.version && old.connected === next.connected ? old : next));
    };
    const detach = attach((changed) => {
      if (changed !== null && changed !== topic) return;
      if (timer) return;
      const wait = throttleMs - (Date.now() - last.current);
      if (wait <= 0) read(); else timer = setTimeout(read, wait);
    });
    read();
    return () => { detach(); if (timer) clearTimeout(timer); };
  }, [topic, throttleMs]);
  return state;
}
