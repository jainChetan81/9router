import { describe, it, expect } from "vitest";
import { parseUrlState, serialiseUrlState, dropMissingDetail, DEFAULT_RANGE, occurrences } from "../../src/app/(dashboard)/dashboard/pii-guard/urlState.js";

describe("masked preview matches", () => {
  it("finds every non-overlapping occurrence", () => {
    expect(occurrences("xx ab ab ab", "ab")).toEqual([3, 6, 9]);
    expect(occurrences("aaaa", "aa")).toEqual([0, 2]);
    expect(occurrences("text", "")).toEqual([]);
  });
});

const sp = (s) => new URLSearchParams(s);
const parse = (s) => parseUrlState(sp(s));

describe("pii-guard url state: parse", () => {
  it("bare URL gives the defaults", () => {
    const s = parse("");
    expect(s.tab).toBe("overview");
    expect(s.view).toBe("value");
    expect(s.q).toBe("");
    expect(s.fAction).toBe("");
    expect(s.range).toEqual(DEFAULT_RANGE);
    expect(s.detailKey).toBeNull();
    expect(s.detailHit).toBeNull();
  });
  it("reads every filter", () => {
    const s = parse("tab=findings&view=hit&q=pan&group=id&action=block&client=Claude&model=gpt-6&source=ocr&tests=1&session=c1&at=p9");
    expect(s).toMatchObject({ tab: "findings", view: "hit", q: "pan", fGroup: "id", fAction: "block", fClient: "Claude", fModel: "gpt-6", fSource: "ocr", tests: true, session: "c1", at: "p9" });
  });
  it("falls back silently on invalid enums", () => {
    const s = parse("tab=nope&view=zzz&action=drop&source=disk&tests=yes");
    expect(s.tab).toBe("overview");
    expect(s.view).toBe("value");
    expect(s.fAction).toBe("");
    expect(s.fSource).toBe("");
    expect(s.tests).toBe(false);
  });
  it("reads a custom range and rejects bad dates", () => {
    expect(parse("range=custom&from=2026-11-01&to=2026-11-05").range).toEqual({ preset: "Custom", from: "2026-11-01", to: "2026-11-05", label: "" });
    expect(parse("range=custom&from=2026-11-05&to=2026-11-01").range).toEqual(DEFAULT_RANGE);
    expect(parse("range=custom&from=yesterday&to=2026-11-01").range).toEqual(DEFAULT_RANGE);
    expect(parse("range=bogus").range).toEqual(DEFAULT_RANGE);
  });
  it("parses finding and hit deep links, rejecting malformed ones", () => {
    expect(parse("finding=abc123:pan").detailKey).toBe("abc123:pan");
    expect(parse("hit=req1:abc123").detailHit).toBe("req1:abc123");
    expect(parse("finding=nocolon").detailKey).toBeNull();
    expect(parse("hit=a:b:c").detailHit).toBeNull();
  });
  it("trims free text", () => {
    expect(parse("q=%20%20pan%20").q).toBe("pan");
  });
});

describe("pii-guard url state: serialise", () => {
  it("omits defaults so the bare URL stays clean", () => {
    expect(serialiseUrlState(parseUrlState(sp(""))).toString()).toBe("");
  });
  it("omits view unless on the findings tab", () => {
    expect(serialiseUrlState({ ...parse(""), view: "hit" }).toString()).toBe("");
    expect(serialiseUrlState({ ...parse("tab=findings"), view: "hit" }).toString()).toBe("tab=findings&view=hit");
  });
  it("round-trips a full state", () => {
    const src = "tab=findings&view=prompt&q=pan&group=id&action=leaked&client=Claude&model=gpt-6&source=text&tests=1&session=c1&at=p9&finding=abc:pan&range=7D";
    const s = parse(src);
    const out = serialiseUrlState(s);
    expect(parse(out.toString())).toEqual(s);
    expect(Object.fromEntries(out)).toEqual(Object.fromEntries(sp(src)));
  });
  it("round-trips a custom range", () => {
    const src = "range=custom&from=2026-11-01&to=2026-11-05";
    expect(serialiseUrlState(parse(src)).toString()).toBe(src);
  });
  it("keeps params it does not own", () => {
    const keep = sp("utm=x&tab=health");
    const out = serialiseUrlState(parse("tab=test"), keep);
    expect(out.get("utm")).toBe("x");
    expect(out.get("tab")).toBe("test");
  });
  it("writes only the drawer param that is set", () => {
    expect(serialiseUrlState({ ...parse(""), detailHit: "r:h" }).toString()).toBe("hit=r%3Ah");
  });
});

describe("pii-guard url state: drawer deep links", () => {
  it("drops a finding that is not in the loaded data", () => {
    const s = dropMissingDetail(parse("finding=abc:pan&hit=r:h"), () => false, () => false);
    expect(s.detailKey).toBeNull();
    expect(s.detailHit).toBeNull();
  });
  it("keeps a finding that is loaded", () => {
    const s = dropMissingDetail(parse("finding=abc:pan"), (k) => k === "abc:pan", () => false);
    expect(s.detailKey).toBe("abc:pan");
  });
});
