import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateModelEffortOverride } = vi.hoisted(() => ({ updateModelEffortOverride: vi.fn() }));

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({ updateModelEffortOverride }));

const { PATCH } = await import("../../src/app/api/settings/model-effort/route.js");

function request(body) {
  return new Request("http://localhost/api/settings/model-effort", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("model effort settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateModelEffortOverride.mockResolvedValue({ modelOverrides: {} });
  });

  it("rejects an invalid effort with valid choices", async () => {
    const response = await PATCH(request({ provider: "cx", model: "gpt-6-luna", effort: "ultra" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.validChoices).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(updateModelEffortOverride).not.toHaveBeenCalled();
  });

  it("rejects efforts for fixed-tier models", async () => {
    const response = await PATCH(request({ provider: "antigravity", model: "gemini-3.8-flash-high", effort: "high" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.validChoices).toEqual(["auto"]);
    expect(updateModelEffortOverride).not.toHaveBeenCalled();
  });

  it.each([
    ["grok-cli", "grok-4.5-low"],
    ["deepseek", "deepseek-v4-pro-none"],
    ["deepseek", "deepseek-v4-pro-max"],
    ["antigravity", "gemini-3.1-pro-high"],
  ])("rejects saved effort edits for fixed preset %s/%s", async (provider, model) => {
    const response = await PATCH(request({ provider, model, effort: "high" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.validChoices).toEqual(["auto"]);
    expect(updateModelEffortOverride).not.toHaveBeenCalled();
  });

  it("writes a valid setting using the canonical provider key", async () => {
    const response = await PATCH(request({ provider: "cx", model: "gpt-6-luna", effort: "high" }));

    expect(response.status).toBe(200);
    expect(updateModelEffortOverride).toHaveBeenCalledWith("codex/gpt-6-luna", "high");
  });
});
