import "open-sse/index.js";
import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { refreshAndUpdateCredentials, isAuthExpiredMessage } from "@/app/api/usage/[connectionId]/route.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { normalizeQuotaRow, sortQuotaRows } from "@/lib/spend/quotaRunway.js";
import { createRefreshDeduper, quotaUsageRows } from "@/lib/spend/quotaSnapshot.js";
import { isSyncRequest } from "@/lib/dashboardSync.js";

export const dynamic = "force-dynamic";
const TTL = 60000, TIMEOUT = 8000;
let cached = null;
let inFlight = null;
const refreshConnection = createRefreshDeduper();

// Stale-while-revalidate: GET returns the last snapshot at once with its
// "as of" time and starts a background refresh when the snapshot is older
// than TTL. A page load never waits on provider APIs; only "Sync now" does.
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

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

// One refresh at a time; every caller that needs one joins it.
function startRefresh() {
  inFlight ||= fetchQuotaSnapshot().then(({ rows, hasSuccess }) => {
    const body = { rows, asOf: Date.now() };
    if (hasSuccess) cached = { body, expiresAt: Date.now() + (rows.some((row) => row.error) ? 15000 : TTL) };
    return body;
  }).catch((error) => {
    // The refresh may run detached behind a stale body; a rejection must
    // never surface as an unhandled rejection (it can kill the process). Keep
    // serving the last snapshot; a later request retries.
    console.error("[quota] refresh failed:", error?.message || error);
    return null;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

// No ETag here: the answer is no-store and the page never sends a
// conditional request.
export async function GET(request) {
  // "Sync now" waits for a snapshot read from the providers now (each read
  // has its own timeout). Everything else gets the last snapshot at once.
  const sync = isSyncRequest(request);
  if (!sync && cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.body, NO_STORE);
  const refresh = startRefresh();
  if (!sync && cached) {
    // Serve the stale snapshot at once. `refreshing` tells the page to ask
    // again shortly for the snapshot this refresh produces.
    return NextResponse.json({ ...cached.body, refreshing: true }, NO_STORE);
  }
  const body = await refresh;
  if (!body) return NextResponse.json({ error: "Quota refresh failed" }, { status: 502, ...NO_STORE });
  return NextResponse.json(body, NO_STORE);
}
