// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { HostHealth } from "@multica/core/types";
import { deriveHostStatus, loadRatio, swapUsedRatio } from "./host-health";

function host(overrides: Partial<HostHealth>): HostHealth {
  return {
    daemon_id: "d",
    device_name: "d",
    ncpu: 8,
    load1: 0,
    load5: 0,
    load15: 0,
    mem_total_kb: 16_000_000,
    mem_available_kb: 16_000_000,
    swap_total_kb: 4_000_000,
    swap_free_kb: 4_000_000,
    ...overrides,
  };
}

describe("deriveHostStatus", () => {
  it("is green under light load with free swap", () => {
    expect(deriveHostStatus(host({ load15: 4 }))).toBe("green"); // 0.5 ratio
  });

  it("goes amber at the load boundary (0.7 x ncpu)", () => {
    expect(deriveHostStatus(host({ load15: 5.6 }))).toBe("amber"); // exactly 0.7
  });

  it("goes red when load exceeds ncpu", () => {
    expect(deriveHostStatus(host({ load15: 8.1 }))).toBe("red");
  });

  it("reflects the incident: load 65 on 8 cores, swap exhausted", () => {
    const h = host({ load15: 65, swap_free_kb: 0 });
    expect(loadRatio(h)).toBeCloseTo(8.125);
    expect(swapUsedRatio(h)).toBe(1);
    expect(deriveHostStatus(h)).toBe("red");
  });

  it("swap pressure alone can drive amber/red even when load is fine", () => {
    expect(deriveHostStatus(host({ swap_free_kb: 2_000_000 }))).toBe("amber"); // 50% used
    expect(deriveHostStatus(host({ swap_free_kb: 400_000 }))).toBe("red"); // 90% used
  });

  it("treats zero ncpu / zero swap as green (no divide-by-zero)", () => {
    expect(deriveHostStatus(host({ ncpu: 0, load15: 99, swap_total_kb: 0, swap_free_kb: 0 }))).toBe("green");
  });
});
