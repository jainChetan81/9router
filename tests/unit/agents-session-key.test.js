import { describe, expect, it } from "vitest";
import { spendMeta } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { sessionKey } from "@/lib/agents/sessionKey.js";

describe("agents session key", () => {
  it.each([
    "claude:550e8400-e29b-41d4-a716-446655440000",
    "codex:0190f3b4-8d25-7c60-a2e2-5c9f625e8249",
  ])("matches requestDetail's dashboard session hash for %s", (rawSession) => {
    expect(sessionKey(rawSession)).toBe(spendMeta({ session: rawSession }, {}).session);
  });

  it("always hashes raw 12-hex identities", () => {
    expect(sessionKey("abcdef123456")).toBe(spendMeta({ session: "abcdef123456" }, {}).session);
    expect(sessionKey("ABCDEF012345")).not.toBe("abcdef012345");
    expect(sessionKey("ABCDEF012345")).not.toBe("abcdef012345");
  });
});
