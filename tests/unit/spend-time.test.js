import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  IST_OFFSET_MS,
  fmtIstDay,
  fmtIstHhmm,
  istDayKey,
  istDayKeyOffset,
  istDayKeyToMs,
  istMidnightMs,
} from "@/lib/spend/time.js";

describe("IST time helpers (B12)", () => {
  const justBeforeIstMidnight = Date.parse("2026-11-09T18:29:59.999Z"); // 23:59:59.999 IST on Nov 9
  const exactIstMidnight = Date.parse("2026-11-09T18:30:00.000Z"); // 00:00:00.000 IST on Nov 10

  it("exports expected constants", () => {
    expect(IST_OFFSET_MS).toBe(5.5 * 3600 * 1000);
    expect(DAY_MS).toBe(86_400_000);
    expect(HOUR_MS).toBe(3_600_000);
  });

  it("splits IST days at 18:30 UTC rather than 00:00 UTC", () => {
    expect(istDayKey(justBeforeIstMidnight)).toBe("2026-11-09");
    expect(istDayKey(exactIstMidnight)).toBe("2026-11-10");
    expect(istDayKey(new Date(exactIstMidnight).toISOString())).toBe("2026-11-10");
  });

  it("computes UTC epoch ms for IST 00:00:00", () => {
    expect(istMidnightMs(justBeforeIstMidnight)).toBe(Date.parse("2026-11-08T18:30:00.000Z"));
    expect(istMidnightMs(exactIstMidnight)).toBe(exactIstMidnight);
    expect(istMidnightMs(Date.parse("2026-11-10T10:15:00.000Z"))).toBe(exactIstMidnight);
  });

  it("offsets IST day keys and converts keys back to IST midnight UTC ms", () => {
    expect(istDayKeyOffset(0, exactIstMidnight)).toBe("2026-11-10");
    expect(istDayKeyOffset(1, exactIstMidnight)).toBe("2026-11-09");
    expect(istDayKeyOffset(6, exactIstMidnight)).toBe("2026-11-04");
    expect(istDayKeyToMs("2026-11-10")).toBe(exactIstMidnight);
  });

  it("formats IST days and HH:MM without 24:00 edge cases", () => {
    expect(fmtIstDay(justBeforeIstMidnight)).toBe("Nov 9");
    expect(fmtIstDay(exactIstMidnight)).toBe("Nov 10");
    expect(fmtIstHhmm(exactIstMidnight)).toBe("00:00");
    expect(fmtIstHhmm(justBeforeIstMidnight)).toBe("23:59");
    expect(fmtIstHhmm(Date.parse("2026-11-09T18:15:00.000Z"))).toBe("23:45");
  });
});
