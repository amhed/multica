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

/** Daemon cgroup memory ÷ its limit, or null when no limit is visible. */
export function daemonMemRatio(host: HostHealth): number | null {
  return host.cgroup_mem_limit_kb > 0 ? host.cgroup_mem_current_kb / host.cgroup_mem_limit_kb : null;
}

/** Whether the daemon reports saturation rates (newer daemons, after their first sample). */
export function hasSaturationSignals(host: HostHealth): boolean {
  return host.cpu_busy_pct != null || host.swap_in_kbps != null;
}

export function formatKBps(kbps: number): string {
  return kbps < 1024 ? `${Math.round(kbps)} KB/s` : `${(kbps / 1024).toFixed(1)} MB/s`;
}

export function formatKB(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

// Overall status is the worst of the signals. With rates available it judges
// what is happening now: paging (swap-in stalls every process that touches a
// swapped page), agent memory against the cgroup limit that throttles it, and
// a pegged CPU as a warning only, since a busy build is not a fault. Load
// average is excluded because it lags by minutes and counts processes waiting
// on disk; swap occupancy is excluded because pages stay parked long after
// pressure ends. Older daemons without rates keep the load15 + swap-used rule.
export function deriveHostStatus(host: HostHealth): HostStatus {
  if (!hasSaturationSignals(host)) {
    const lr = loadRatio(host);
    const sr = swapUsedRatio(host);
    const load: HostStatus = lr > 1.0 ? "red" : lr >= 0.7 ? "amber" : "green";
    const swap: HostStatus = sr > 0.75 ? "red" : sr >= 0.25 ? "amber" : "green";
    return worst(load, swap);
  }
  const swapIn = host.swap_in_kbps ?? 0;
  const paging: HostStatus = swapIn > 10_240 ? "red" : swapIn >= 1024 ? "amber" : "green";
  const mr = daemonMemRatio(host) ?? 0;
  const memory: HostStatus = mr > 0.95 ? "red" : mr >= 0.8 ? "amber" : "green";
  const cpu: HostStatus = (host.cpu_busy_pct ?? 0) >= 90 ? "amber" : "green";
  return worst(paging, memory, cpu);
}
