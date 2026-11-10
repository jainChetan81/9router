import { NextResponse } from "next/server";
import { conversation, message as messageOf, sessions } from "@/lib/piiGuard/prompts.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const ID = /^[\w:.@-]{1,200}$/;
const DAY = 864e5;
const TTL = 14 * DAY;

function rangeOf(p) {
  const int = (k, d) => { const v = p.get(k); if (v === null || v === "") return d; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : NaN; };
  const from = int("from", Date.now() - DAY - TTL), to = int("to", Date.now());
  if ([from, to].some(Number.isNaN) || from > to) return null;
  return { from, to: Math.min(to, Date.now()) };
}

export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const range = rangeOf(p);
  if (!range) return NextResponse.json({ error: "Invalid range" }, { status: 400, headers: NO_STORE });
  // Sessions list. Filters are validated identifiers, not free text with values.
  if (!p.has("sessionId")) {
    const int = (k, d) => { const v = p.get(k); if (v === null || v === "") return d; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : NaN; };
    const before = int("before", Infinity), limit = int("limit", 50);
    if ([before, limit].some(Number.isNaN)) return NextResponse.json({ error: "Invalid cursor" }, { status: 400, headers: NO_STORE });
    const [q, client, provider, combo, hash] = ["q", "client", "provider", "combo", "hash"].map((k) => (p.get(k) || "").slice(0, 100));
    if (hash && !/^[0-9a-f]{12}$/.test(hash)) return NextResponse.json({ error: "Invalid filter" }, { status: 400, headers: NO_STORE });
    if ([client, provider, combo].some((v) => v && !ID.test(v))) return NextResponse.json({ error: "Invalid filter" }, { status: 400, headers: NO_STORE });
    const findings = p.get("findings") === "1" ? true : p.get("findings") === "0" ? false : null;
    try {
      return NextResponse.json(sessions({ q, client, provider, combo, hash, findings, ...range, before, limit }), { headers: NO_STORE });
    } catch {
      return NextResponse.json({ error: "Session list failed" }, { status: 500, headers: NO_STORE });
    }
  }
  // One conversation, oldest first. `after` pages an oversized session by message id.
  const sessionId = p.get("sessionId") || "";
  if (!ID.test(sessionId)) return NextResponse.json({ error: "Invalid session id" }, { status: 400, headers: NO_STORE });
  const int = (k, d) => { const v = p.get(k); if (v === null || v === "") return d; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : NaN; };
  const after = int("after", 0);
  if (Number.isNaN(after)) return NextResponse.json({ error: "Invalid cursor" }, { status: 400, headers: NO_STORE });
  try {
    const r = conversation({ sessionId, ...range, after });
    if (r.unavailable) return NextResponse.json({ error: "Prompt store unavailable" }, { status: 503, headers: NO_STORE });
    return NextResponse.json(r, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Session load failed" }, { status: 500, headers: NO_STORE });
  }
}
