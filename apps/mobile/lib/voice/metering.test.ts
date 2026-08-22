import { describe, expect, it } from "vitest";
import { normalizeMetering } from "./metering";

describe("normalizeMetering", () => {
  it("maps silence and missing values to a low floor", () => {
    expect(normalizeMetering(undefined)).toBeGreaterThan(0);
    expect(normalizeMetering(-160)).toBe(0);
  });

  it("maps 0 dB to full amplitude", () => {
    expect(normalizeMetering(0)).toBe(1);
  });
});
