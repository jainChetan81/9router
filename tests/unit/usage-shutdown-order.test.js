import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-shutdown-"));
process.env.DATA_DIR = tempDataDir;

let db;
let usageRepo;
let hooks;
let paths;

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  hooks = await import("@/lib/db/shutdownHooks.js");
  paths = await import("@/lib/db/paths.js");
});

describe("database shutdown hooks", () => {
  it("runs hooks in registration order and survives a failing hook", () => {
    const calls = [];
    hooks.onBeforeDbClose("test-a", () => calls.push("a"));
    hooks.onBeforeDbClose("test-b", () => { throw new Error("boom"); });
    hooks.onBeforeDbClose("test-c", () => calls.push("c"));
    // Registering a name again replaces the hook; it does not stack.
    hooks.onBeforeDbClose("test-a", () => calls.push("a2"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    hooks.runBeforeDbClose();
    error.mockRestore();
    expect(calls).toEqual(["a2", "c"]);
    for (const name of ["test-a", "test-b", "test-c"]) hooks.onBeforeDbClose(name, () => {});
  });

  it("flushes the usageDaily buffer before the adapter closes the database", async () => {
    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "shutdown-order",
      model: "m1",
      tokens: { prompt_tokens: 2, completion_tokens: 3 },
      status: "ok",
    });
    expect(usageRepo.globalFlushBuffer().size).toBe(1);

    // The adapter was loaded before usageRepo, so its handler is first in
    // line. It must flush the buffer and only then close.
    const { getAdapterSync } = await import("@/lib/db/driver.js");
    const adapter = getAdapterSync();
    process.emit("beforeExit", 0);
    expect(usageRepo.globalFlushBuffer().size).toBe(0);
    expect(() => adapter.get("SELECT 1 AS one")).toThrow(); // closed

    const check = new DatabaseSync(paths.DATA_FILE, { readOnly: true });
    const rows = check.prepare("SELECT data FROM usageDaily").all();
    check.close();
    const total = rows.reduce((n, r) => n + (JSON.parse(r.data).byProvider?.["shutdown-order"]?.requests || 0), 0);
    expect(total).toBe(1);
  });
});
