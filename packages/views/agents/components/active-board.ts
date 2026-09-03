import type { AgentTask } from "@multica/core/types";
import { stripMentionMarkdown } from "../../issues/utils/strip-mention-markdown";

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
  | { source: "pstack_summary" | "handoff_note" | "trigger_summary"; text: string }
  | { source: "kind"; kind: NonNullable<AgentTask["kind"]> | "unknown" };

/**
 * The best available one-liner for what a task is about. The generated
 * headline wins; then the assigner's note; then the triggering comment. With
 * none of those, the caller labels the task by how it was created.
 */
export function taskSummary(task: AgentTask): TaskSummary {
  const generated = task.pstack_summary?.trim();
  if (generated) return { source: "pstack_summary", text: generated };
  const note = task.handoff_note?.trim();
  if (note) return { source: "handoff_note", text: note };
  const trigger = task.trigger_summary?.trim();
  if (trigger) return { source: "trigger_summary", text: trigger };
  return { source: "kind", kind: task.kind ?? "unknown" };
}

export interface ActiveTaskGroup {
  /** Issue id, or the task id for tasks with no linked issue. */
  key: string;
  issueId: string;
  tasks: AgentTask[];
}

/**
 * Fold tasks on the same issue into one group so a running run and its queued
 * follow-up read as one unit. Input order is preserved: a group sits where its
 * first (highest-ranked) task sat.
 */
export function groupActiveTasks(tasks: readonly AgentTask[]): ActiveTaskGroup[] {
  const groups: ActiveTaskGroup[] = [];
  const byIssue = new Map<string, ActiveTaskGroup>();
  for (const task of tasks) {
    if (!task.issue_id) {
      groups.push({ key: task.id, issueId: "", tasks: [task] });
      continue;
    }
    const existing = byIssue.get(task.issue_id);
    if (existing) {
      existing.tasks.push(task);
      continue;
    }
    const group = { key: task.issue_id, issueId: task.issue_id, tasks: [task] };
    byIssue.set(task.issue_id, group);
    groups.push(group);
  }
  return groups;
}

/**
 * Comment and note text arrives as markdown. Render it as prose for a
 * one-line summary: mentions and links keep their label, inline code loses
 * its backticks, and whitespace collapses to single spaces.
 */
export function plainSummary(text: string): string {
  return stripMentionMarkdown(text)
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** How many tasks are running versus waiting (queued, dispatched, parked). */
export function activeCounts(tasks: readonly AgentTask[]): { running: number; waiting: number } {
  let running = 0;
  for (const task of tasks) if (task.status === "running") running += 1;
  return { running, waiting: tasks.length - running };
}

/** A running task with no transcript activity for this long is worth a look. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isStale(lastActivityAt: string, now: number = Date.now()): boolean {
  return now - new Date(lastActivityAt).getTime() > STALE_AFTER_MS;
}
