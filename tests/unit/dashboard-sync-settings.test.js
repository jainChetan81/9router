import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ password: "hash", oidcClientSecret: "secret", dashboardSync: { agents: 30 }, requireLogin: true, theme: "dark" }),
  updateSettings: async () => ({}),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: () => {} }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: () => {} }));

const { GET } = await import("../../src/app/api/settings/route.js");
const get = async (query = "") => (await GET(new Request(`http://localhost/api/settings${query}`))).json();

describe("GET /api/settings?fields=", () => {
  it("returns only the fields asked for", async () => {
    expect(await get("?fields=dashboardSync")).toEqual({ dashboardSync: { agents: 30 } });
    expect(await get("?fields=dashboardSync,theme,unknown")).toEqual({ dashboardSync: { agents: 30 }, theme: "dark" });
  });
  it("cannot select a secret: it picks from the filtered response", async () => {
    expect(await get("?fields=password,oidcClientSecret,hasPassword")).toEqual({ hasPassword: true });
  });
  it("without fields, and when called without a request, returns everything as before", async () => {
    const full = await get();
    expect(full).toMatchObject({ dashboardSync: { agents: 30 }, theme: "dark", hasPassword: true });
    expect(full.password).toBeUndefined();
    expect(await (await GET()).json()).toEqual(full);
  });
});
