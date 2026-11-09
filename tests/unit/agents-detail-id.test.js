import { describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/agents/sessions/[id]/route.js";

describe("agent session detail id validation", () => {
  it("returns 400 for invalid ids and malformed percent encoding", async () => {
    const request = new Request("http://localhost/api/agents/sessions/not-an-id");
    const invalid = await GET(request, { params: Promise.resolve({ id: "not-an-id" }) });
    expect(invalid.status).toBe(400);

    const malformed = await GET(request, { params: Promise.resolve({ id: "%" }) });
    expect(malformed.status).toBe(400);
  });
});
