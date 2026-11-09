import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const previousDataDir = process.env.DATA_DIR;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-overrides-route-"));
process.env.DATA_DIR = tempDataDir;
const SESSION = "abcdef123456";
let db;
let handlers;

function request(url, method, body, origin = "http://localhost") {
  return new Request(url, {
    method,
    headers: {
      host: "localhost",
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const context = { params: Promise.resolve({ id: SESSION }) };

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.createCombo({ name: "assistant", models: ["openai/gpt-4o-mini", "cc/claude-sonnet-5-5", "cc/claude-opus-5-5"] });
  await db.createCombo({ name: "fusion-demo", models: ["openai/gpt-4o-mini"] });
  await db.updateSettings({ comboStrategy: "fallback", comboStrategies: { "fusion-demo": { fallbackStrategy: "fusion" } } });
  await db.saveRequestUsage({
    timestamp: new Date().toISOString(),
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "route-test-key",
    promptTokens: 1,
    completionTokens: 1,
    tokens: { prompt_tokens: 1, completion_tokens: 1 },
    cost: 0,
    status: "ok",
    meta: { session: SESSION, combo: "assistant", ua: "Codex/1.0" },
  });
  handlers = await import("@/app/api/agents/sessions/[id]/overrides/route.js");
});

afterAll(async () => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

describe("agents session overrides route", () => {
  it("validates targets, writes an override, lists it, and enforces revision checks", async () => {
    const invalidModel = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/missing-model", fallback: false,
      expiry: "1h", revision: 0,
    }), context);
    expect(invalidModel.status).toBe(404);

    const saved = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false,
      expiry: "1h", revision: 0,
    }), context);
    expect(saved.status).toBe(200);
    expect((await saved.json()).override).toMatchObject({ revision: 1, status: "pending" });

    const staleCurrent = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false,
      expiry: "1h", revision: 1, expectedCurrent: "openai/stale-model",
    }), context);
    expect(staleCurrent.status).toBe(409);
    expect(await staleCurrent.json()).toMatchObject({ error: "Current model changed", currentModel: "gpt-4o-mini" });

    const listed = await handlers.GET(new Request("http://localhost/api/agents/sessions/abcdef123456/overrides"), context);
    expect((await listed.json()).overrides).toHaveLength(1);

    const conflict = await handlers.DELETE(request("http://localhost/api/agents/sessions/abcdef123456/overrides?combo=assistant&revision=0", "DELETE"), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "Revision conflict", currentRevision: 1 });

    const deleted = await handlers.DELETE(request("http://localhost/api/agents/sessions/abcdef123456/overrides?combo=assistant&revision=1", "DELETE"), context);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, revision: 2 });
  });

  it("requires same-origin writes, rejects fusion combos, and applies Codex provider rules", async () => {
    const crossOrigin = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: true, expiry: "session", revision: 2,
    }, "http://evil.example"), context);
    expect(crossOrigin.status).toBe(403);

    const fusion = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "fusion-demo", mode: "override", model: "openai/gpt-4o-mini", fallback: true, expiry: "session", revision: 0,
    }), context);
    expect(fusion.status).toBe(400);

    const codexBlocked = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "anthropic/claude-sonnet-4-20250514", fallback: true, expiry: "session", revision: 2,
    }), context);
    expect(codexBlocked.status).toBe(400);
  });

  it("matches Origin against the request origin and Host, without trusting forwarded headers", async () => {
    const httpsAccepted = await handlers.PUT(request("https://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 999,
    }, "https://localhost"), context);
    expect(httpsAccepted.status).toBe(409);

    const missingOrigin = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 999,
    }, null), context);
    expect(missingOrigin.status).toBe(403);

    const portMismatch = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 999,
    }, "http://localhost:3000"), context);
    expect(portMismatch.status).toBe(403);

    const forwardedHostRequest = new Request("http://localhost/api/agents/sessions/abcdef123456/overrides", {
      method: "PUT",
      headers: {
        host: "localhost",
        origin: "https://agents.example.ts.net",
        "x-forwarded-host": "agents.example.ts.net",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
      },
      body: JSON.stringify({ combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 999 }),
    });
    expect((await handlers.PUT(forwardedHostRequest, context)).status).toBe(403);
  });

  it("accepts an Origin listed in DASHBOARD_TRUSTED_ORIGINS behind a loopback proxy", async () => {
    const body = { combo: "assistant", mode: "override", model: "openai/gpt-4o-mini", fallback: false, expiry: "1h", revision: 999 };
    const tailnet = "https://agents.example.ts.net:20128";
    process.env.DASHBOARD_TRUSTED_ORIGINS = `${tailnet}, not a url`;
    try {
      const listed = await handlers.PUT(request("http://127.0.0.1:20128/api/agents/sessions/abcdef123456/overrides", "PUT", body, tailnet), context);
      expect(listed.status).toBe(409);
      const unlisted = await handlers.PUT(request("http://127.0.0.1:20128/api/agents/sessions/abcdef123456/overrides", "PUT", body, "https://evil.example.ts.net:20128"), context);
      expect(unlisted.status).toBe(403);
    } finally {
      delete process.env.DASHBOARD_TRUSTED_ORIGINS;
    }
  });

  it("requires explicit confirmation for Opus and Fable targets", async () => {
    const response = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "cc/claude-opus-5-5", fallback: true, expiry: "session", revision: 2,
    }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Explicit confirmation is required for this model" });

    const confirmed = await handlers.PUT(request("http://localhost/api/agents/sessions/abcdef123456/overrides", "PUT", {
      combo: "assistant", mode: "override", model: "cc/claude-opus-5-5", fallback: true,
      expiry: "session", revision: 2, confirmExpensive: true,
    }), context);
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).override).toMatchObject({ model: "cc/claude-opus-5-5", revision: 3 });
  });
});
