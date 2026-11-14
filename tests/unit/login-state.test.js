import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canSubmitLogin, showDefaultPasswordHint } from "../../src/app/login/loginState.js";

describe("login form", () => {
  it("shows the default-password hint only when no password is set", () => {
    expect(showDefaultPasswordHint(false)).toBe(true);
    expect(showDefaultPasswordHint(true)).toBe(false);
    expect(showDefaultPasswordHint(null)).toBe(false); // status not loaded yet
    expect(showDefaultPasswordHint(undefined)).toBe(false);
  });
  it("cannot submit an empty password or during a lockout", () => {
    expect(canSubmitLogin({ password: "", retryAfter: 0 })).toBe(false);
    expect(canSubmitLogin({ password: "secret", retryAfter: 0 })).toBe(true);
    expect(canSubmitLogin({ password: "secret", retryAfter: 12 })).toBe(false);
    expect(canSubmitLogin()).toBe(false);
  });
  it("the page uses both, and mentions the default password only inside the hint", () => {
    const page = readFileSync(new URL("../../src/app/login/page.js", import.meta.url), "utf8");
    expect(page).toContain("disabled={!canSubmitLogin({ password, retryAfter })}");
    const hint = page.indexOf("{showDefaultPasswordHint(hasPassword) && (");
    expect(hint).toBeGreaterThan(0);
    expect(page.indexOf("123456")).toBeGreaterThan(hint);
    expect(page.match(/123456/g)).toHaveLength(1);
  });
});
