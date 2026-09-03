import type { TraceCallStep, TraceStep } from "../../common/task-transcript/build-steps";
import { describeStep, plainSummary, type StepDescription } from "./active-board";

export type ConversationBlock =
  | { kind: "agent_text"; seq: number; text: string; at?: string }
  | { kind: "files"; seq: number; paths: string[] }
  | { kind: "commands"; seq: number; runs: { command: string; ok: boolean | null; seq: number }[] }
  | { kind: "other"; seq: number; steps: StepDescription[] }
  | { kind: "error"; seq: number; text: string };

// The transcript stream carries no success/failure flag on a tool result
// (`TimelineItem` has no such field); a failed call surfaces as a separate
// `type: "error"` row, not something attached to the result. Outcome is
// unknown until the pipeline carries a real flag.
function commandOutcome(_step: TraceCallStep): boolean | null {
  return null;
}

/**
 * Fold a transcript into the shape a conversation reads in: agent prose as
 * bubbles, and the tool work between two bubbles as at most three blocks in
 * a fixed order (files, commands, everything else). Thinking is dropped.
 */
export function buildConversation(steps: readonly TraceStep[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let pending: TraceCallStep[] = [];

  const flush = () => {
    const first = pending[0];
    if (!first) return;
    const firstSeq = first.seq;
    const paths = new Set<string>();
    const runs: { command: string; ok: boolean | null; seq: number }[] = [];
    const other: StepDescription[] = [];
    for (const step of pending) {
      const d = describeStep(step);
      if (d.verb === "edited" && d.object) paths.add(d.object);
      else if (d.verb === "ran") runs.push({ command: d.object, ok: commandOutcome(step), seq: step.seq });
      else other.push(d);
    }
    if (paths.size > 0) blocks.push({ kind: "files", seq: firstSeq, paths: [...paths] });
    if (runs.length > 0) blocks.push({ kind: "commands", seq: firstSeq, runs });
    if (other.length > 0) blocks.push({ kind: "other", seq: firstSeq, steps: other });
    pending = [];
  };

  for (const step of steps) {
    if (step.kind === "thinking") continue;
    if (step.kind === "call") {
      pending.push(step);
      continue;
    }
    flush();
    const text = plainSummary(step.item.content ?? "");
    if (step.kind === "error") blocks.push({ kind: "error", seq: step.seq, text });
    else blocks.push({ kind: "agent_text", seq: step.seq, text, at: step.startedAt });
  }
  flush();
  return blocks;
}
