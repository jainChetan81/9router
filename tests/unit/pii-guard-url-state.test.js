import { describe, it, expect } from "vitest";
import { parseUrlState, serialiseUrlState, dropMissingDetail, validDate, rangeLabel, buildRangeKey, buildEventsFilterKey, buildEventsRequestKey, nextHitLookupCursor, HIT_LOOKUP_PAGE_LIMIT, clearPromptLandingOnNavigation, shouldSyncSearchInput, shouldDropMissingDetail, DEFAULT_RANGE, occurrences } from "../../src/app/(dashboard)/dashboard/pii-guard/urlState.js";

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
    expect(parse("range=custom&from=2026-11-01&to=2026-11-05").range).toEqual({ preset: "Custom", from: "2026-11-01", to: "2026-11-05", label: "Nov 1 – Nov 5" });
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
  it("keeps the raw search text so a trailing space survives the round-trip", () => {
    expect(parse("q=pan%20").q).toBe("pan ");
    expect(parse("q=%20%20pan%20").q).toBe("  pan ");
  });
  it("builds the custom range label in picker format", () => {
    expect(parse("range=custom&from=2026-11-01&to=2026-11-05").range.label).toBe("Nov 1 – Nov 5");
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
  it("keeps a search typed in pieces and drops only a blank one", () => {
    expect(serialiseUrlState({ ...parse(""), q: "John " }).get("q")).toBe("John ");
    expect(serialiseUrlState({ ...parse(""), q: "   " }).has("q")).toBe(false);
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

describe("pii-guard url state: calendar dates", () => {
  it("accepts real days and rejects impossible ones", () => {
    expect(validDate("2026-11-05")).toBe(true);
    expect(validDate("2028-02-29")).toBe(true);
    expect(validDate("2026-02-29")).toBe(false);
    expect(validDate("2026-99-99")).toBe(false);
    expect(validDate("2026-1-5")).toBe(false);
  });
  it("rejects a custom range with an impossible day", () => {
    expect(parse("range=custom&from=2026-99-99&to=2026-11-05").range).toEqual(DEFAULT_RANGE);
  });
  it("formats the label like the picker", () => {
    expect(rangeLabel("2026-01-09", "2026-12-31")).toBe("Jan 9 – Dec 31");
  });
});

describe("pii-guard request state keys", () => {
  const range = { preset: "Custom", from: "2026-11-01", to: "2026-11-05" };

  it("keys summary and event data by the range and event filters", () => {
    const rangeKey = buildRangeKey(range);
    const filterKey = buildEventsFilterKey(range, { client: "Claude", q: "pan", tests: true });
    expect(buildRangeKey({ ...range })).toBe(rangeKey);
    expect(buildRangeKey({ ...range, to: "2026-11-06" })).not.toBe(rangeKey);
    expect(buildEventsFilterKey(range, { client: "Claude", q: "pan", tests: true })).toBe(filterKey);
    expect(buildEventsFilterKey(range, { client: "Claude", q: "pan ", tests: true })).not.toBe(filterKey);
    expect(buildEventsRequestKey(filterKey, { before: 10, skip: 4 })).not.toBe(buildEventsRequestKey(filterKey, null));
  });

  it("syncs URL search only for external navigation, not our pending writes", () => {
    const ownWrites = new Set(["tab=findings&q=old", "tab=findings&q=new"]);
    expect(shouldSyncSearchInput("tab=findings&q=old", ownWrites)).toBe(false);
    expect(shouldSyncSearchInput("tab=findings&q=external", ownWrites)).toBe(true);
    expect(shouldSyncSearchInput("tab=findings&q=old", ownWrites, true)).toBe(true);
  });

  it("drops a missing detail only after the current request succeeds", () => {
    expect(shouldDropMissingDetail({ currentKey: "new", loadedKey: "old", succeeded: true, found: false })).toBe(false);
    expect(shouldDropMissingDetail({ currentKey: "new", loadedKey: "new", succeeded: false, found: false })).toBe(false);
    expect(shouldDropMissingDetail({ currentKey: "new", loadedKey: "new", succeeded: true, found: true })).toBe(false);
    expect(shouldDropMissingDetail({ currentKey: "new", loadedKey: "new", succeeded: true, found: false })).toBe(true);
  });
});

describe("prompt landing navigation", () => {
  const prompt = parse("tab=findings&view=prompt&session=s1&at=p9&finding=abc:pan");

  it("clears the prompt marker and its finding when leaving prompt view", () => {
    expect(clearPromptLandingOnNavigation(prompt, { ...prompt, view: "hit" })).toMatchObject({ view: "hit", at: "", detailKey: null });
  });

  it("clears the prompt marker and its finding when changing tabs", () => {
    expect(clearPromptLandingOnNavigation(prompt, { ...prompt, tab: "rules" })).toMatchObject({ tab: "rules", at: "", detailKey: null });
  });

  it("keeps prompt landing state for other changes and preserves findings without a marker", () => {
    expect(clearPromptLandingOnNavigation(prompt, { ...prompt, q: "pan" })).toMatchObject({ at: "p9", detailKey: "abc:pan" });
    const ordinary = { ...prompt, at: "", detailKey: "abc:pan" };
    expect(clearPromptLandingOnNavigation(ordinary, { ...ordinary, tab: "rules" }).detailKey).toBe("abc:pan");
  });
});

describe("cold hit lookup paging", () => {
  it("continues with the API cursor until a hit, end of data, or the page cap", () => {
    const cursor = { before: 10, skip: 2 };
    expect(nextHitLookupCursor({ pageCount: 1, next: cursor })).toBe(cursor);
    expect(nextHitLookupCursor({ pageCount: 1, next: null })).toBeNull();
    expect(nextHitLookupCursor({ pageCount: 1, next: cursor, found: true })).toBeNull();
    expect(nextHitLookupCursor({ pageCount: HIT_LOOKUP_PAGE_LIMIT - 1, next: cursor })).toBe(cursor);
    expect(nextHitLookupCursor({ pageCount: HIT_LOOKUP_PAGE_LIMIT, next: cursor })).toBeNull();
  });
});

describe("session view url state", () => {
  const base = { tab: "findings", view: "session", ssort: "last", sdesc: true, sf: {} };
  it("round-trips session sort, direction and filters, omitting defaults", () => {
    const qs = serialiseUrlState({ ...base, ssort: "requests", sdesc: false, sf: { client: "codex", provider: "", combo: "gpt/astra", hash: "0a1b2c3d4e5f", findings: "1" } });
    expect(qs.toString()).toBe("tab=findings&view=session&ssort=requests&sdesc=0&sclient=codex&scombo=gpt%2Fastra&shash=0a1b2c3d4e5f&sfind=1");
    const p = parseUrlState(qs);
    expect(p.tab).toBe("findings");
    expect(p.view).toBe("session");
    expect(p.ssort).toBe("requests");
    expect(p.sdesc).toBe(false);
    expect(p.sf).toEqual({ client: "codex", provider: "", combo: "gpt/astra", hash: "0a1b2c3d4e5f", findings: "1" });
    const plain = serialiseUrlState({ ...base, sf: { client: "codex" } });
    expect(plain.toString()).toBe("tab=findings&view=session&sclient=codex");
    const p2 = parseUrlState(plain);
    expect(p2.ssort).toBe("last");
    expect(p2.sdesc).toBe(true);
    expect(p2.sf).toEqual({ client: "codex", provider: "", combo: "", hash: "", findings: "" });
  });
  it("drops session state once the view changes and keeps a hashed session id in the URL", () => {
    const withSession = serialiseUrlState({ ...base, session: "a1b2c3d4e5f60718", sf: { client: "codex" } });
    expect(withSession.toString()).toBe("tab=findings&view=session&sclient=codex&session=a1b2c3d4e5f60718");
    expect(parseUrlState(withSession).session).toBe("a1b2c3d4e5f60718");
    const value = serialiseUrlState({ ...base, view: "value", sf: { client: "x" } });
    expect(value.toString()).toBe("tab=findings");
  });
});
