import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { agentTaskSnapshotKeys } from "./queries";

/**
 * Stop action for the Active board's running cards (MUL-6975 fix wave).
 * No optimistic update: the board derives every card's state from the
 * snapshot, so a settle-time invalidate is enough to pick up the task's
 * cancelled status. Matches the existing call sites' behavior of not
 * confirming before cancelling.
 */
export function useCancelTask(wsId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (taskId: string) => api.cancelTaskById(taskId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
    },
  });
}
