import type { HostHealth } from "@multica/core/types";

export type HostStatus = "green" | "amber" | "red";

const RANK: Record<HostStatus, number> = { green: 0, amber: 1, red: 2 };

function worst(...statuses: HostStatus[]): HostStatus {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green");
}

/** load15 ÷ ncpu: < 0.7 green, 0.7–1.0 amber, > 1.0 red. */
export function loadRatio(host: HostHealth): number {
  return host.ncpu > 0 ? host.load15 / host.ncpu : 0;
}

/** Fraction of swap in use: < 0.25 green, 0.25–0.75 amber, > 0.75 red. */
export function swapUsedRatio(host: HostHealth): number {
  return host.swap_total_kb > 0 ? 1 - host.swap_free_kb / host.swap_total_kb : 0;
}

/** Fraction of memory in use (shown in detail; does not drive status). */
export function memUsedRatio(host: HostHealth): number {
  return host.mem_total_kb > 0 ? 1 - host.mem_available_kb / host.mem_total_kb : 0;
}

// Overall status is the worst of load and swap. load15 (not load1) drives the
// headline so a brief spike does not flip the card red.
export function deriveHostStatus(host: HostHealth): HostStatus {
  const lr = loadRatio(host);
  const sr = swapUsedRatio(host);
  const load: HostStatus = lr > 1.0 ? "red" : lr >= 0.7 ? "amber" : "green";
  const swap: HostStatus = sr > 0.75 ? "red" : sr >= 0.25 ? "amber" : "green";
  return worst(load, swap);
}
