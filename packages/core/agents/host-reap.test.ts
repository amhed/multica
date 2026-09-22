import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHostReap, hostReapKeys } from "./host-reap";
import type { HostReapRequest } from "../types/agent";

const initiateHostReap = vi.fn();
const getHostReapResult = vi.fn();

vi.mock("../api", () => ({
  api: {
    initiateHostReap: (daemonId: string, mode: "dryrun" | "apply") =>
      initiateHostReap(daemonId, mode),
    getHostReapResult: (daemonId: string, requestId: string) =>
      getHostReapResult(daemonId, requestId),
  },
}));

function request(overrides: Partial<HostReapRequest>): HostReapRequest {
  return {
    id: "r1",
    daemon_id: "daemon-1",
    workspace_id: "ws-1",
    runtime_id: "rt-1",
    mode: "dryrun",
    status: "pending",
    result: null,
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  initiateHostReap.mockReset();
  getHostReapResult.mockReset();
});

describe("resolveHostReap", () => {
  it("polls pending then resolves on completed", async () => {
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult
      .mockResolvedValueOnce(request({ status: "pending" }))
      .mockResolvedValueOnce(
        request({
          status: "completed",
          result: {
            mode: "dryrun",
            count: 1,
            load_before: "1 1 1",
            load_after: null,
            sigkilled: null,
            processes: [],
          },
        }),
      );

    const result = await resolveHostReap("daemon-1", "dryrun");

    expect(result.status).toBe("completed");
    expect(result.result?.count).toBe(1);
    expect(getHostReapResult).toHaveBeenCalledWith("daemon-1", "r1");
  });

  it("returns a timeout status once the client gives up polling", async () => {
    vi.useFakeTimers();
    try {
      initiateHostReap.mockResolvedValue({ request_id: "r1" });
      getHostReapResult.mockResolvedValue(request({ status: "pending" }));

      const pending = resolveHostReap("daemon-1", "dryrun");
      const settled = pending.then((value) => ({ ok: true as const, value }));

      await vi.advanceTimersByTimeAsync(60_000);

      const outcome = await settled;
      expect(outcome.ok).toBe(true);
      expect(outcome.value.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hostReapKeys", () => {
  it("scopes a query key to the daemon", () => {
    expect(hostReapKeys.forDaemon("daemon-1")).toEqual([
      "host-health",
      "reap",
      "daemon-1",
    ]);
  });
});
