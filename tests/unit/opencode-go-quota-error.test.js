import { describe, expect, it } from "vitest";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.js";

const quotaFixture = {
  type: "error",
  error: {
    type: "GoUsageLimitError",
    message: "Go usage limit exceeded",
  },
  metadata: {
    workspace: "workspace-must-not-be-retained",
    limitName: "weekly",
  },
};

function response(body, status = 429) {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

describe("OpenCode Go paid quota error parsing", () => {
  it("carries a typed quota failure through the chat error result", async () => {
    const parsed = await parseUpstreamError(
      response(JSON.stringify(quotaFixture)),
      new OpenCodeGoExecutor(),
    );

    expect(parsed).toMatchObject({
      statusCode: 429,
      message: "Go usage limit exceeded (weekly)",
      quotaFailure: { kind: "opencode-go-paid", limitName: "weekly" },
    });
    expect(parsed.quotaFailure).not.toHaveProperty("workspace");

    const result = createErrorResult(parsed.statusCode, parsed.message, parsed.resetsAtMs, null, parsed.quotaFailure);
    expect(result.quotaFailure).toEqual({ kind: "opencode-go-paid", limitName: "weekly" });
  });

  it("never passes upstream quota text through", async () => {
    const echoed = { ...quotaFixture, error: { ...quotaFixture.error, message: "limit hit for key sk-echoed-secret" } };
    const parsed = await parseUpstreamError(response(JSON.stringify(echoed)), new OpenCodeGoExecutor());
    expect(parsed.message).toBe("Go usage limit exceeded (weekly)");
    expect(JSON.stringify(parsed)).not.toContain("sk-echoed-secret");
  });

  it("does not classify malformed or unrelated 429 responses", async () => {
    const executor = new OpenCodeGoExecutor();
    const malformed = await parseUpstreamError(response("{bad json"), executor);
    const ordinary = await parseUpstreamError(response(JSON.stringify({ error: { type: "RateLimitError", message: "slow down" } })), executor);

    expect(malformed).not.toHaveProperty("quotaFailure");
    expect(ordinary).not.toHaveProperty("quotaFailure");
  });

  it.each([
    ["credential-like", "sk-abc123-secret"],
    ["long junk", "x".repeat(256)],
  ])("does not retain an unrecognized limit name (%s)", async (_label, limitName) => {
    const parsed = await parseUpstreamError(
      response(JSON.stringify({
        ...quotaFixture,
        metadata: { ...quotaFixture.metadata, limitName },
      })),
      new OpenCodeGoExecutor(),
    );

    expect(parsed.quotaFailure).toEqual({ kind: "opencode-go-paid", limitName: null });
  });

  it("does not classify the same body under another provider parser", async () => {
    const parsed = await parseUpstreamError(response(JSON.stringify(quotaFixture)), {
      parseError: (upstream, bodyText) => ({ status: upstream.status, message: bodyText }),
    });

    expect(parsed.statusCode).toBe(429);
    expect(parsed).not.toHaveProperty("quotaFailure");
  });
});
