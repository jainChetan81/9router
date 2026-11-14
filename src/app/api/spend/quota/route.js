import "open-sse/index.js";
import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { refreshAndUpdateCredentials, isAuthExpiredMessage } from "@/app/api/usage/[connectionId]/route.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { normalizeQuotaRow, sortQuotaRows } from "@/lib/spend/quotaRunway.js";
import { createRefreshDeduper, quotaUsageRows } from "@/lib/spend/quotaSnapshot.js";
import { version as quotaVersion } from "@/lib/live/bus.js";

export const dynamic = "force-dynamic";
const TTL = 60000, TIMEOUT = 8000;
let cached = null;
let inFlight = null;
const refreshConnection = createRefreshDeduper();

// Stale-while-revalidate: GET returns the last snapshot at once with its
// "as of" time and starts a background refresh when the snapshot is older
// than TTL. The page never waits on provider APIs.
async function readConnection(connection, now) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Usage request timed out")), TIMEOUT); });
  return Promise.race([readConnectionWork(connection, now), deadline]).finally(() => clearTimeout(timer));
}

async function readConnectionWork(connection, now) {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = { connectionProxyEnabled: proxy.connectionProxyEnabled === true, connectionProxyUrl: proxy.connectionProxyUrl || "", connectionNoProxy: proxy.connectionNoProxy || "", vercelRelayUrl: proxy.vercelRelayUrl || "", strictProxy: false };
    const oauth = connection.authType === "oauth";
    const apikey = ["apikey", "api_key"].includes(connection.authType) && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
    if (!oauth && !apikey) throw new Error("Usage not available for this connection");
    if (oauth) {
      connection = (await refreshConnection(connection.id, () => refreshAndUpdateCredentials(connection, false, proxyOptions))).connection;
    }
    let usage = await getUsageForProvider(connection, proxyOptions);
    if (oauth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      const retry = await refreshConnection(connection.id, () => refreshAndUpdateCredentials(connection, true, proxyOptions));
      connection = retry.connection;
      usage = await getUsageForProvider(connection, proxyOptions);
    }
    return quotaUsageRows({ usage, connection, now, normalize: normalizeQuotaRow });
}

async function fetchQuotaSnapshot() {
  const now = Date.now();
  try {
    const providers = ["claude", "codex", "antigravity", "opencode-go", "muse"];
    const connections = (await Promise.all(providers.map((provider) => getProviderConnections({ provider, isActive: true })))).flat();
    const results = await Promise.all(connections.map(async (connection) => {
      try { return await readConnection(connection, now); }
      catch (error) { return [{ provider: connection.provider, name: connection.name || connection.provider, error: error?.message || "Usage request failed" }]; }
    }));
    const rows = sortQuotaRows(results.flat());
    return { rows, hasSuccess: rows.some((row) => !row.error) };
  } catch (error) { throw error; }
}

export async function GET(request) {
  const etag = `"q${quotaVersion("quota")}-${cached ? Math.floor(cached.expiresAt / TTL) : "none"}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
  }
  const fresh = cached && cached.expiresAt > Date.now();
  if (fresh) return NextResponse.json(cached.body, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  if (!inFlight) {
    inFlight = fetchQuotaSnapshot().then(({ rows, hasSuccess }) => {
      const body = { rows, asOf: Date.now() };
      if (hasSuccess) cached = { body, expiresAt: Date.now() + (rows.some((row) => row.error) ? 15000 : TTL) };
      return body;
    }).catch((error) => {
      // The refresh runs detached behind a stale body; a rejection must never
      // surface as an unhandled rejection (it can kill the process). Keep
      // serving the last snapshot; a later request retries.
      console.error("[quota] background refresh failed:", error?.message || error);
      return null;
    }).finally(() => { inFlight = null; });
  }
  if (cached) {
    // Serve the stale snapshot at once; the refresh lands on a later request.
    return NextResponse.json({ ...cached.body, refreshing: true }, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  }
  try { return NextResponse.json(await inFlight, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 500 }); }
}
