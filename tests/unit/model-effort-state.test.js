import { describe, expect, it } from "vitest";
import { mergeSavedModelOverride } from "../../src/app/(dashboard)/dashboard/providers/[id]/modelEffortState.js";

describe("saved model effort UI state", () => {
  it("merges the returned key without dropping another model saved concurrently", () => {
    const current = {
      "codex/gpt-6-luna": { effort: "high", locked: false },
      "codex/gpt-6-sol": { effort: "low", locked: true },
    };

    const next = mergeSavedModelOverride(current, "codex/gpt-6-luna", {
      "codex/gpt-6-luna": { effort: "medium", locked: false },
    });

    expect(next).toEqual({
      "codex/gpt-6-luna": { effort: "medium", locked: false },
      "codex/gpt-6-sol": { effort: "low", locked: true },
    });
  });

  it("removes only the returned key when the server snapshot cleared it", () => {
    const current = {
      "codex/gpt-6-luna": { effort: "high", locked: false },
      "codex/gpt-6-sol": { effort: "low", locked: true },
    };

    const next = mergeSavedModelOverride(current, "codex/gpt-6-luna", {
      "codex/gpt-6-sol": { effort: "low", locked: true },
    });

    expect(next).toEqual({ "codex/gpt-6-sol": { effort: "low", locked: true } });
  });
});
