import { subscribe } from "@/lib/live/bus.js";

export const dynamic = "force-dynamic";

const MAX_CONNECTIONS = 20;
let activeConnections = 0;

/**
 * Strips any sensitive fields (prompt text, keys, user agents) from payloads.
 * Only counters, status codes, and identifiers are permitted on the stream.
 */
function sanitizePayload(data) {
  if (data == null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizePayload);

  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    // Drop sensitive fields
    if (/prompt|text|key|token|auth|secret|ua|useragent|cookie/i.test(k) && typeof v === "string") {
      continue;
    }
    if (v && typeof v === "object") {
      clean[k] = sanitizePayload(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export async function GET(request) {
  if (activeConnections >= MAX_CONNECTIONS) {
    return new Response("Too many live stream connections", {
      status: 429,
      headers: { "Retry-After": "5" },
    });
  }

  activeConnections++;
  const encoder = new TextEncoder();

  let isClosed = false;
  let keepaliveTimer = null;
  let unsubscribe = null;
  const topicTimers = new Map();
  const pendingByTopic = new Map();
  const lastSentByTopic = new Map();

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    activeConnections = Math.max(0, activeConnections - 1);

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    for (const timer of topicTimers.values()) {
      clearTimeout(timer);
    }
    topicTimers.clear();
    pendingByTopic.clear();
  };

  request?.signal?.addEventListener?.("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (event) => {
        if (isClosed) return;
        try {
          const payload = {
            topic: event.topic,
            v: event.v,
          };
          if (event.data !== undefined) {
            payload.data = sanitizePayload(event.data);
          }
          controller.enqueue(encoder.encode(`event: v\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const handleBusEvent = (event) => {
        if (isClosed) return;
        const topic = event.topic;
        const now = Date.now();
        const lastSent = lastSentByTopic.get(topic) || 0;
        const elapsed = now - lastSent;

        // Coalesce: max ~4/s per topic (250 ms interval)
        if (elapsed >= 250) {
          lastSentByTopic.set(topic, now);
          sendEvent(event);
        } else {
          pendingByTopic.set(topic, event);
          if (!topicTimers.has(topic)) {
            const timer = setTimeout(() => {
              topicTimers.delete(topic);
              if (isClosed) return;
              const pending = pendingByTopic.get(topic);
              pendingByTopic.delete(topic);
              if (pending) {
                lastSentByTopic.set(topic, Date.now());
                sendEvent(pending);
              }
            }, 250 - elapsed);
            timer?.unref?.();
            topicTimers.set(topic, timer);
          }
        }
      };

      unsubscribe = subscribe(handleBusEvent);

      // Ping keepalive every 25 seconds
      keepaliveTimer = setInterval(() => {
        if (isClosed) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
      keepaliveTimer?.unref?.();
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
