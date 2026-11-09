import { describe, it, expect } from "vitest";
import { feeError, feesValid, shortRange, tickStep, clampWindow, pickSelection } from "../../src/app/(dashboard)/dashboard/spend/helpers.js";

describe("fee validation (S1)", () => {
  it("accepts empty and non-negative numbers", () => {
    expect(feeError("")).toBe("");
    expect(feeError("0")).toBe("");
    expect(feeError("20")).toBe("");
    expect(feeError("19.99")).toBe("");
  });
  it("rejects negative, non-numeric and malformed values", () => {
    expect(feeError("-50")).toBe("Fees cannot be negative.");
    expect(feeError("abc")).toBe("Enter a number, 0 or more.");
    expect(feeError("1e")).toBe("Enter a number, 0 or more.");
  });
  it("blocks Save when any draft value is invalid", () => {
    expect(feesValid({ a: "20", b: "" })).toBe(true);
    expect(feesValid({ a: "20", b: "-1" })).toBe(false);
  });
});

describe("short custom range label (A33)", () => {
  it("uses a single month when both dates share one", () => {
    expect(shortRange("2026-11-05", "2026-11-08")).toBe("Nov 5–8");
  });
  it("names both months across a month boundary", () => {
    expect(shortRange("2026-11-28", "2026-12-02")).toBe("Nov 28 – Dec 2");
  });
  it("shows one date for a single-day range", () => {
    expect(shortRange("2026-11-09", "2026-11-09")).toBe("Nov 9");
  });
});

describe("tick step (S2)", () => {
  it("keeps the desktop step", () => {
    expect(tickStep(30)).toBe(3);
  });
  it("thins daily ticks on narrow widths", () => {
    expect(tickStep(30, { narrow: true })).toBe(6);
  });
  it("never returns less than 1", () => {
    expect(tickStep(0)).toBe(1);
  });
});

describe("timeline window (A18)", () => {
  const len = 6 * 3600e3;
  it("keeps a window that already ends before now", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const start = Date.parse("2026-11-09T02:00:00Z");
    expect(clampWindow(start, len, now, start)).toEqual([start, start + len]);
  });
  it("slides a future window back so it ends at now", () => {
    const now = Date.parse("2026-11-09T08:00:00Z");
    const start = Date.parse("2026-11-09T06:00:00Z");
    const [s, e] = clampWindow(start, len, now, Date.parse("2026-11-09T07:59:00Z"));
    expect(e).toBe(now);
    expect(s).toBe(now - len);
  });
});

describe("selection (A15, A16)", () => {
  it("keeps the current id while it is still listed", () => {
    expect(pickSelection("b", ["a", "b"])).toBe("b");
  });
  it("clears the selection when the id is filtered out", () => {
    expect(pickSelection("b", ["a"])).toBe(null);
  });
  it("returns null when nothing is selected", () => {
    expect(pickSelection(null, ["a"])).toBe(null);
  });
});
