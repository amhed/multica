import { describe, expect, it } from "vitest";
import { HostReapRequestSchema, MALFORMED_HOST_REAP_REQUEST } from "./schemas";
import { parseWithFallback } from "./schema";

describe("HostReapRequestSchema", () => {
  it("falls back on malformed payload", () => {
    const out = parseWithFallback(
      { garbage: true },
      HostReapRequestSchema,
      { ...MALFORMED_HOST_REAP_REQUEST, id: "r1" },
      { endpoint: "test" },
    );
    expect(out.id).toBe("r1");
    expect(out.status).toBe("failed");
  });

  it("parses a completed dry-run result", () => {
    const out = parseWithFallback(
      {
        id: "r1",
        status: "completed",
        mode: "dryrun",
        result: {
          mode: "dryrun",
          count: 0,
          load_before: "0 0 0",
          load_after: null,
          sigkilled: null,
          processes: [],
        },
      },
      HostReapRequestSchema,
      { ...MALFORMED_HOST_REAP_REQUEST, id: "r1" },
      { endpoint: "test" },
    );
    expect(out.result?.count).toBe(0);
  });
});
