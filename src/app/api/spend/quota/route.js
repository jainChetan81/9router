import "open-sse/index.js";
import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { refreshAndUpdateCredentials, isAuthExpiredMessage } from "@/app/api/usage/[connectionId]/route.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { normalizeQuotaRow, sortQuotaRows } from "@/lib/spend/quotaRunway.js";

export const dynamic = "force-dynamic";
const TTL = 60000, TIMEOUT = 8000;
let cached = null;
let inFlight = null;
const refreshing = new Map();

async function readConnection(connection, now) {
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("Usage request timed out")), TIMEOUT));
  return Promise.race([readConnectionWork(connection, now), deadline]);
}

async function readConnectionWork(connection, now) {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = { connectionProxyEnabled: proxy.connectionProxyEnabled === true, connectionProxyUrl: proxy.connectionProxyUrl || "", connectionNoProxy: proxy.connectionNoProxy || "", vercelRelayUrl: proxy.vercelRelayUrl || "", strictProxy: false };
    const oauth = connection.authType === "oauth";
    const apikey = ["apikey", "api_key"].includes(connection.authType) && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
    if (!oauth && !apikey) throw new Error("Usage not available for this connection");
    if (oauth) {
      const refresh = refreshing.get(connection.id) || refreshAndUpdateCredentials(connection, false, proxyOptions);
      refreshing.set(connection.id, refresh);
      try { connection = (await refresh).connection; } finally { if (refreshing.get(connection.id) === refresh) refreshing.delete(connection.id); }
    }
    let usage = await getUsageForProvider(connection, proxyOptions);
    if (oauth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      const retry = await refreshAndUpdateCredentials(connection, true, proxyOptions);
      connection = retry.connection;
      usage = await getUsageForProvider(connection, proxyOptions);
    }
    if (usage?.message && !usage?.quotas) throw new Error(usage.message);
    return Object.entries(usage?.quotas || {}).map(([key, q]) => ({ ...normalizeQuotaRow({ provider: connection.provider, name: connection.name || connection.provider, quota: { ...q, name: key }, now }), window: q.displayName ? `${key} (${q.displayName})` : key }));
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

export async function GET() {
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.body, { headers: { "Cache-Control": "no-store" } });
  if (!inFlight) {
    inFlight = fetchQuotaSnapshot().then(({ rows, hasSuccess }) => {
      const body = { rows };
      if (hasSuccess) cached = { body, expiresAt: Date.now() + (rows.some((row) => row.error) ? 15000 : TTL) };
      return body;
    }).finally(() => { inFlight = null; });
  }
  try { return NextResponse.json(await inFlight, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 500 }); }
}
