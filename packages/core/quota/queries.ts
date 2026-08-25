import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const quotaKeys = {
  snapshot: () => ["quota", "snapshot"] as const,
};

// Deployment-level, not workspace-scoped: the snapshot describes the host the
// server runs on. The collector rewrites it every few minutes, so poll gently.
export function quotaOptions() {
  return queryOptions({
    queryKey: quotaKeys.snapshot(),
    queryFn: () => api.getQuota(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
