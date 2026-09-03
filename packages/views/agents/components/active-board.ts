import type { AgentTask } from "@multica/core/types";
import type { TraceStep } from "../../common/task-transcript/build-steps";
import { traceToolArgSummary } from "../../common/task-transcript/trace-event-presenter";
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

export type StepVerb = "edited" | "read" | "ran" | "searched" | "used" | "said" | "errored";

export interface StepDescription {
  /** i18n key under active_board.step; the card translates it. */
  verb: StepVerb;
  object: string;
  tone: "normal" | "error";
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit_file", "write_file"]);
const READ_TOOLS = new Set(["Read", "read_file", "view", "cat"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "WebSearch", "WebFetch", "search", "grep", "glob", "find"]);

/**
 * One transcript step as a verb and an object, ready to read as a sentence.
 * Shell-like calls are recognised by a `command` input, not a tool allowlist,
 * so the rule holds across agent backends.
 */
export function describeStep(step: TraceStep): StepDescription {
  if (step.kind === "call") {
    const input = step.call?.input as Record<string, unknown> | undefined;
    const summary = traceToolArgSummary(input);
    if (typeof input?.command === "string") return { verb: "ran", object: summary, tone: "normal" };
    // File tools show the full path: traceToolArgSummary shortens long paths
    // for a narrow table row, which loses information a card has room for.
    const filePath = typeof input?.file_path === "string" ? input.file_path : summary;
    if (EDIT_TOOLS.has(step.tool)) return { verb: "edited", object: filePath, tone: "normal" };
    if (READ_TOOLS.has(step.tool)) return { verb: "read", object: filePath, tone: "normal" };
    if (SEARCH_TOOLS.has(step.tool)) return { verb: "searched", object: summary, tone: "normal" };
    return { verb: "used", object: [step.tool, summary].filter(Boolean).join(" "), tone: "normal" };
  }
  const text = plainSummary(step.item.content ?? "");
  if (step.kind === "error") return { verb: "errored", object: text, tone: "error" };
  return { verb: "said", object: text, tone: "normal" };
}

/** A completed task stays on the board this long, so a question is not missed. */
export const RECENT_TERMINAL_MS = 60 * 60 * 1000;

function completedWithin(task: AgentTask, windowMs: number, now: number): boolean {
  if (!task.completed_at) return false;
  return now - new Date(task.completed_at).getTime() <= windowMs;
}

/**
 * A finished run whose last words were a question is blocked on a person.
 * Only completed tasks qualify: a failed run is an error, not a question.
 */
export function isWaitingForInput(task: AgentTask, steps: readonly TraceStep[], now: number = Date.now()): boolean {
  if (task.status !== "completed" || !completedWithin(task, RECENT_TERMINAL_MS, now)) return false;
  const lastText = steps.filter((s) => s.kind === "text").at(-1);
  if (!lastText || lastText.kind !== "text") return false;
  return /[?？]\s*$/.test(plainSummary(lastText.item.content ?? ""));
}

/** Active tasks plus completed tasks recent enough to still be waiting on someone. */
export function selectBoardTasks(snapshot: readonly AgentTask[], now: number = Date.now()): AgentTask[] {
  return snapshot.filter(
    (t) => ACTIVE_STATUSES.has(t.status) || (t.status === "completed" && completedWithin(t, RECENT_TERMINAL_MS, now)),
  );
}

export interface BoardCard {
  task: AgentTask;
  waiting: boolean;
  /** Last transcript activity for running tasks; null when unknown. */
  lastActivityAt: string | null;
}

/**
 * Waiting cards first, then running by most recent activity, then dispatched
 * and queued by start time. A recent terminal task that is not waiting has
 * nothing to show and is dropped.
 */
export function sortBoardCards(cards: readonly BoardCard[]): BoardCard[] {
  const startOf = (t: AgentTask) => t.started_at ?? t.dispatched_at ?? t.created_at;
  return cards
    .filter((c) => c.waiting || ACTIVE_STATUSES.has(c.task.status))
    .sort((a, b) => {
      if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
      const rank = (STATUS_RANK[a.task.status] ?? 9) - (STATUS_RANK[b.task.status] ?? 9);
      if (rank !== 0) return rank;
      const aAt = a.lastActivityAt ?? startOf(a.task);
      const bAt = b.lastActivityAt ?? startOf(b.task);
      return bAt.localeCompare(aAt);
    });
}
