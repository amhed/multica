import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const deployKeys = {
  snapshot: () => ["deploy", "snapshot"] as const,
};

// Deployment-level, not workspace-scoped: the snapshot describes the host the
// server runs on. The collector rewrites it every few minutes, so poll gently.
export function deployOptions() {
  return queryOptions({
    queryKey: deployKeys.snapshot(),
    queryFn: () => api.getDeploy(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
