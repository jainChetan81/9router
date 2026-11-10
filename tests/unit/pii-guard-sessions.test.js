import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(() => ({ rows: [], next: null })),
  conversation: vi.fn(() => ({ sessionId: "s1" })),
}));
vi.mock("@/lib/piiGuard/prompts.js", () => ({ sessions: mocks.sessions, conversation: mocks.conversation, message: vi.fn() }));
const { sessions, conversation } = mocks;

import { GET } from "../../src/app/api/pii-guard/sessions/route.js";
const get = (q) => GET(new Request(`http://localhost/api/pii-guard/sessions?${q}`));

beforeEach(() => { vi.clearAllMocks(); });

describe("pii-guard sessions route", () => {
  it("rejects an invalid range and invalid filters with 400", async () => {
    expect((await get("from=abc&to=1")).status).toBe(400);
    expect((await get("from=2&to=1")).status).toBe(400);
    expect((await get("hash=zzz")).status).toBe(400);
    expect((await get("client=bad id")).status).toBe(400);
    expect(sessions).not.toHaveBeenCalled();
  });
  it("maps list params into the store and paginates", async () => {
    sessions.mockReturnValueOnce({ rows: [{ sessionId: "a" }], next: 42 });
    const res = await get("client=codex&provider=pr&combo=cb&hash=0a1b2c3d4e5f&findings=1&q=needle&before=99&limit=7&from=10&to=20");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(sessions).toHaveBeenCalledWith({ q: "needle", client: "codex", provider: "pr", combo: "cb", hash: "0a1b2c3d4e5f", findings: true, from: 10, to: 20, before: 99, limit: 7 });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.next).toBe(42);
  });
  it("findings accepts only 0 or 1", async () => {
    await get("findings=maybe");
    expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ findings: null }));
    await get("findings=0");
    expect(sessions).toHaveBeenLastCalledWith(expect.objectContaining({ findings: false }));
  });
  it("indexes a conversation by session id and fails closed on bad ids", async () => {
    expect((await get("sessionId=bad%20id")).status).toBe(400);
    conversation.mockReturnValueOnce({ unavailable: true });
    expect((await get("sessionId=s1")).status).toBe(503);
    expect((await get("sessionId=s1&from=5&to=9&after=3")).status).toBe(200);
    expect(conversation).toHaveBeenCalledWith({ sessionId: "s1", from: 5, to: 9, after: 3 });
  });
  it("turns store throws into 500, not an outage", async () => {
    sessions.mockImplementationOnce(() => { throw Error("boom"); });
    expect((await get("")).status).toBe(500);
    conversation.mockImplementationOnce(() => { throw Error("boom"); });
    expect((await get("sessionId=s1")).status).toBe(500);
  });
});
