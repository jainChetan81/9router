import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-target-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("safe usage targets", () => {
  it("keeps registered models, combos, and custom models, and drops untrusted ids", async () => {
    const [{ resolveSafeUsageTarget }, localDb, { PROVIDER_MODELS }] = await Promise.all([
      import("../../src/sse/services/usageTarget.js"),
      import("@/lib/localDb"),
      import("open-sse/config/providerModels.js"),
    ]);
    await (await import("@/lib/db/driver.js")).getAdapter();

    const knownId = PROVIDER_MODELS.openai.find((entry) => typeof entry.id === "string")?.id;
    expect(await resolveSafeUsageTarget(`openai/${knownId}`, { provider: "openai", model: knownId }))
      .toEqual({ provider: "openai", model: knownId });

    expect(await resolveSafeUsageTarget("openai/private client text", { provider: "openai", model: "private client text" }))
      .toEqual({ provider: "openai", model: "invalid" });
    expect(await resolveSafeUsageTarget("private-provider/private client text", { provider: "private-provider", model: "private client text" }))
      .toEqual({ provider: null, model: "invalid" });

    await localDb.createCombo({ name: "registered-combo", models: [`openai/${knownId}`] });
    expect(await resolveSafeUsageTarget("registered-combo"))
      .toEqual({ provider: null, model: "registered-combo" });

    await localDb.addCustomModel({ providerAlias: "openai", id: "custom-safe-model" });
    expect(await resolveSafeUsageTarget("openai/custom-safe-model", { provider: "openai", model: "custom-safe-model" }))
      .toEqual({ provider: "openai", model: "custom-safe-model" });
  }, 15000);
});
