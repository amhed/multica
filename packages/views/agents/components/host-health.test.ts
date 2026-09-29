// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { HostHealth } from "@multica/core/types";
import {
  daemonMemRatio,
  deriveHostStatus,
  formatKBps,
  loadRatio,
  swapUsedRatio,
} from "./host-health";

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
    cpu_busy_pct: null,
    swap_in_kbps: null,
    swap_out_kbps: null,
    procs_blocked: null,
    cgroup_mem_current_kb: 0,
    cgroup_mem_limit_kb: 0,
    tasks: [],
    stale: null,
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

// A daemon that reports rates is judged on what is happening now, not on the
// 15-minute load average or on how much swap is merely occupied.
describe("deriveHostStatus with saturation signals", () => {
  const measured = { cpu_busy_pct: 10, swap_in_kbps: 0, swap_out_kbps: 0, procs_blocked: 0 };

  it("ignores a lagging load15 and parked swap once rates are reported", () => {
    // The moni-hermes reading 5 minutes after a restart: load15 still 16 on
    // 4 cores and 3.6 of 11 GB swap occupied, but the CPU idle and no paging.
    const h = host({ ...measured, ncpu: 4, load15: 16.2, swap_total_kb: 11_000_000, swap_free_kb: 7_400_000 });
    expect(deriveHostStatus(h)).toBe("green");
  });

  it("goes amber then red on swap-in rate", () => {
    expect(deriveHostStatus(host({ ...measured, swap_in_kbps: 1023 }))).toBe("green");
    expect(deriveHostStatus(host({ ...measured, swap_in_kbps: 1024 }))).toBe("amber");
    expect(deriveHostStatus(host({ ...measured, swap_in_kbps: 10_241 }))).toBe("red");
  });

  it("goes amber then red as agent memory nears the daemon cgroup limit", () => {
    const limit = { cgroup_mem_limit_kb: 15_728_640 };
    expect(deriveHostStatus(host({ ...measured, ...limit, cgroup_mem_current_kb: 12_000_000 }))).toBe("green");
    expect(deriveHostStatus(host({ ...measured, ...limit, cgroup_mem_current_kb: 12_582_912 }))).toBe("amber"); // 80%
    expect(deriveHostStatus(host({ ...measured, ...limit, cgroup_mem_current_kb: 15_700_000 }))).toBe("red");
  });

  it("treats a pegged CPU as amber, never red on its own", () => {
    expect(deriveHostStatus(host({ ...measured, cpu_busy_pct: 89 }))).toBe("green");
    expect(deriveHostStatus(host({ ...measured, cpu_busy_pct: 90 }))).toBe("amber");
    expect(deriveHostStatus(host({ ...measured, cpu_busy_pct: 100 }))).toBe("amber");
  });

  it("reflects the thrash: 15 of 15 GB cgroup memory while paging hard", () => {
    const h = host({
      ...measured,
      cpu_busy_pct: 60,
      swap_in_kbps: 40_000,
      cgroup_mem_current_kb: 15_600_000,
      cgroup_mem_limit_kb: 15_728_640,
    });
    expect(deriveHostStatus(h)).toBe("red");
  });
});

describe("daemonMemRatio", () => {
  it("is null without a visible limit", () => {
    expect(daemonMemRatio(host({ cgroup_mem_current_kb: 4_000_000, cgroup_mem_limit_kb: 0 }))).toBeNull();
  });

  it("is current / limit", () => {
    expect(daemonMemRatio(host({ cgroup_mem_current_kb: 5, cgroup_mem_limit_kb: 10 }))).toBe(0.5);
  });
});

describe("formatKBps", () => {
  it("uses KB/s below 1 MB/s and MB/s above", () => {
    expect(formatKBps(0)).toBe("0 KB/s");
    expect(formatKBps(102.4)).toBe("102 KB/s");
    expect(formatKBps(40_960)).toBe("40.0 MB/s");
  });
});
