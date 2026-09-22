import { api } from "../api";
import type { HostReapRequest } from "../types/agent";

export const hostReapKeys = {
  all: () => ["host-health", "reap"] as const,
  forDaemon: (daemonId: string) => [...hostReapKeys.all(), daemonId] as const,
};

const POLL_INTERVAL_MS = 1_000;
// The daemon picks up a queued reap on its next heartbeat (~15s cadence,
// see runtimeHeartbeatDBFlushInterval commentary in
// server/internal/handler/daemon.go) and the scan itself is a fast local
// process listing, not a network round trip. 45s covers a slow heartbeat
// tick plus slack without leaving the admin staring at a spinner for the
// full retention window the server holds completed records for.
const POLL_TIMEOUT_MS = 45_000;

// resolveHostReap enqueues a reaper run against a daemon's host and polls
// until the request reaches a terminal status or the client gives up.
// Unlike resolveRuntimeModels, a client-side give-up is not an error: it
// returns a synthetic `timeout` record so the admin-triggered action always
// resolves to a request the UI can render (e.g. "still running, check back"),
// rather than throwing and losing the request id the server is still
// tracking.
export async function resolveHostReap(
  daemonId: string,
  mode: "dryrun" | "apply",
): Promise<HostReapRequest> {
  const initial = await api.initiateHostReap(daemonId, mode);
  const start = Date.now();
  let current = await api.getHostReapResult(daemonId, initial.request_id);
  while (current.status === "pending" || current.status === "running") {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      return { ...current, status: "timeout" };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await api.getHostReapResult(daemonId, initial.request_id);
  }
  return current;
}
