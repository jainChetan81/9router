import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const previousDataDir = process.env.DATA_DIR;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-overrides-batch-"));
process.env.DATA_DIR = tempDataDir;
let batch;

const get = (q) => batch.GET(new Request(`http://localhost/api/agents/overrides${q}`));

beforeAll(async () => {
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  batch = await import("../../src/app/api/agents/overrides/route.js");
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe("batch overrides route", () => {
  it("returns one entry per valid session and skips invalid ids", async () => {
    const res = await get("?ids=abcdef123456,ABCDEF123456,bad-id,0123456789ab");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.sessions).sort()).toEqual(["0123456789ab", "abcdef123456"]);
    expect(body.sessions.abcdef123456).toEqual({ overrides: [], revisions: {} });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns an empty map with no ids", async () => {
    const body = await (await get("")).json();
    expect(body.sessions).toEqual({});
  });

  it("rejects more than 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(12, "0")).join(",");
    expect((await get(`?ids=${ids}`)).status).toBe(400);
  });
});
