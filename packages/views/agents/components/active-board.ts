import type { AgentTask } from "@multica/core/types";

/** Statuses that count as "working now" on the active board. */
const ACTIVE_STATUSES: ReadonlySet<AgentTask["status"]> = new Set([
  "running",
  "waiting_local_directory",
  "dispatched",
  "queued",
]);

const STATUS_RANK: Record<string, number> = {
  running: 0,
  waiting_local_directory: 1,
  dispatched: 2,
  queued: 3,
};

/**
 * Active tasks from the agent task snapshot, running first, then the most
 * recently started within each status. The snapshot also carries each agent's
 * last terminal task; those are dropped here.
 */
export function selectActiveTasks(snapshot: readonly AgentTask[]): AgentTask[] {
  return snapshot
    .filter((t) => ACTIVE_STATUSES.has(t.status))
    .sort((a, b) => {
      const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      const aAt = a.started_at ?? a.dispatched_at ?? a.created_at;
      const bAt = b.started_at ?? b.dispatched_at ?? b.created_at;
      return bAt.localeCompare(aAt);
    });
}

export type TaskSummary =
  | { source: "handoff_note" | "trigger_summary"; text: string }
  | { source: "kind"; kind: NonNullable<AgentTask["kind"]> | "unknown" };

/**
 * The best available one-liner for what a task is about. The assigner's note
 * wins over the triggering comment; with neither, the caller labels the task
 * by how it was created.
 */
export function taskSummary(task: AgentTask): TaskSummary {
  const note = task.handoff_note?.trim();
  if (note) return { source: "handoff_note", text: note };
  const trigger = task.trigger_summary?.trim();
  if (trigger) return { source: "trigger_summary", text: trigger };
  return { source: "kind", kind: task.kind ?? "unknown" };
}
