import { describe, it, expect } from "vitest";

import { isModelLockActive } from "../../open-sse/services/accountFallback.js";

describe("account model locks", () => {
  it("does not let an expired specific lock mask an active all-model lock", () => {
    const connection = {
      modelLock_modelA: new Date(Date.now() - 60_000).toISOString(),
      modelLock___all: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(isModelLockActive(connection, "modelA")).toBe(true);
  });

  it("keeps an active specific model lock effective when the all-model lock expired", () => {
    const connection = {
      modelLock_modelA: new Date(Date.now() + 60_000).toISOString(),
      modelLock___all: new Date(Date.now() - 60_000).toISOString(),
    };

    expect(isModelLockActive(connection, "modelA")).toBe(true);
    expect(isModelLockActive(connection, "modelB")).toBe(false);
  });
});
