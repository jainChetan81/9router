import { statsEmitter, getSlimUsageStats } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const clients = new Set();
const MAX_CONNECTIONS = 20;

let lastBroadcastTime = 0;
let broadcastTimer = null;
let cachedPayload = null;
let cachedAt = 0;
// A connecting client may reuse the last broadcast only this long. Without
// traffic the last broadcast can be hours old and still list requests that
// were in flight back then.
const CONNECT_REUSE_MS = 1000;
let isBroadcasting = false;
let keepaliveTimer = null;

async function doBroadcast() {
  if (clients.size === 0 || isBroadcasting) return;
  isBroadcasting = true;
  lastBroadcastTime = Date.now();
  try {
    const slim = await getSlimUsageStats();
    cachedPayload = encoder.encode(`data: ${JSON.stringify(slim)}\n\n`);
    cachedAt = Date.now();
    for (const client of clients) {
      try {
        client.controller.enqueue(cachedPayload);
      } catch {
        client.cleanup();
      }
    }
  } catch (err) {
    console.error("[usage/stream] broadcast error:", err);
  } finally {
    isBroadcasting = false;
  }
}

function triggerBroadcast() {
  if (clients.size === 0) return;

  const now = Date.now();
  const elapsed = now - lastBroadcastTime;

  if (elapsed >= 1000) {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    doBroadcast();
  } else if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      doBroadcast();
    }, 1000 - elapsed);
    broadcastTimer?.unref?.();
  }
}

// Subscribe once to statsEmitter for shared broadcast
if (!global._usageStreamWired) {
  global._usageStreamWired = true;
  statsEmitter.on("update", triggerBroadcast);
  statsEmitter.on("pending", triggerBroadcast);
}

function ensureKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    if (clients.size === 0) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      return;
    }
    const ping = encoder.encode(": ping\n\n");
    for (const c of clients) {
      try {
        c.controller.enqueue(ping);
      } catch {
        c.cleanup();
      }
    }
  }, 25000);
  keepaliveTimer?.unref?.();
}

export async function GET(request) {
  if (clients.size >= MAX_CONNECTIONS) {
    return new Response("Too many usage stream connections", {
      status: 429,
      headers: { "Retry-After": "5" },
    });
  }

  const client = { controller: null, closed: false, cleanup: null };

  const cleanup = () => {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    if (clients.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };
  client.cleanup = cleanup;

  request?.signal?.addEventListener?.("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      client.controller = controller;
      clients.add(client);

      try {
        // The slim payload is built from memory (pending counters and the
        // recent ring), so a fresh one per connect is cheap.
        if (!cachedPayload || Date.now() - cachedAt > CONNECT_REUSE_MS) {
          const slim = await getSlimUsageStats();
          cachedPayload = encoder.encode(`data: ${JSON.stringify(slim)}\n\n`);
          cachedAt = Date.now();
        }
        controller.enqueue(cachedPayload);
      } catch {
        cleanup();
        return;
      }

      ensureKeepalive();
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
