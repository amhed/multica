"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { agentListOptions } from "@multica/core/workspace/queries";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT, useTimeAgo } from "../../i18n";
import { buildTimeline } from "../../common/task-transcript/build-timeline";
import { buildSteps, type TraceStep } from "../../common/task-transcript/build-steps";
import { traceToolArgSummary } from "../../common/task-transcript/trace-event-presenter";
import { TranscriptButton } from "../../common/task-transcript/transcript-button";
import { isStale, plainSummary, taskSummary } from "./active-board";

const PEEK_ITEMS = 3;

type ActiveStatus = "running" | "waiting_local_directory" | "dispatched" | "queued";

interface ActiveTaskCardProps {
  wsId: string;
  task: AgentTask;
}

/**
 * One row per active task under its issue: who is working, what they are
 * doing now, and a live peek at the last few transcript steps. Tool calls
 * read as `Tool argument`, never as raw JSON.
 */
export function ActiveTaskCard({ wsId, task }: ActiveTaskCardProps) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === task.agent_id);
  const isRunning = task.status === "running";

  // Holding this cache entry is what lets the WS `task:message` stream flow
  // for the task (MUL-6396), so it is mounted only while the task runs.
  const { data: messages = [] } = useQuery({
    ...taskMessagesOptions(task.id),
    enabled: isRunning && taskMessagesOptions(task.id).enabled,
  });
  const { peek, lastText, lastActivityAt } = useMemo(() => {
    const steps = buildSteps(buildTimeline(messages)).filter((s) => s.kind !== "thinking");
    const lastTextStep = steps.filter((s) => s.kind === "text").at(-1);
    const last = steps.at(-1);
    // The latest text becomes the card's "doing now" line; repeating it in
    // the peek would say the same thing twice.
    return {
      peek: steps.filter((s) => s !== lastTextStep).slice(-PEEK_ITEMS),
      lastText: lastTextStep ? stepText(lastTextStep) : "",
      lastActivityAt: last?.startedAt ?? (last?.kind === "call" ? last.endedAt : undefined),
    };
  }, [messages]);

  const summary = taskSummary(task);
  const triggerText =
    summary.source === "kind"
      ? t(($) => $.active_board.kind[summary.kind])
      : plainSummary(summary.text);
  // What the agent last said is a better "doing now" line than the comment
  // that woke it; the trigger stays reachable on hover.
  const doingText = isRunning && lastText ? lastText : triggerText;

  const startedAt = task.started_at ?? task.dispatched_at ?? task.created_at;
  const stale = isRunning && isStale(lastActivityAt ?? startedAt);
  const timeLabel =
    isRunning && lastActivityAt
      ? t(($) => $.active_board.active_ago, { ago: timeAgo(lastActivityAt) })
      : t(($) => $.active_board.started_ago, { ago: timeAgo(startedAt) });

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <ActorAvatar actorType="agent" actorId={task.agent_id} size="sm" profileLink={false} />
        {agent ? (
          <span className="truncate text-body font-medium">{agent.name}</span>
        ) : (
          <Skeleton className="h-4 w-24" />
        )}
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-body",
            stale ? "text-warning" : "text-muted-foreground",
          )}
        >
          <StatusDot status={task.status} stale={stale} />
          <span>{t(($) => $.active_board.status[task.status as ActiveStatus])}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{timeLabel}</span>
        </span>
        <div className="ml-auto shrink-0">
          {agent && (
            <TranscriptButton
              task={task}
              agentName={agent.name}
              isLive={isRunning}
              title={t(($) => $.active_board.view_transcript)}
            />
          )}
        </div>
      </div>

      <p className="line-clamp-2 text-body text-muted-foreground" title={triggerText}>
        {doingText}
      </p>

      {isRunning && (
        <ul className="flex flex-col gap-1 border-t pt-2 text-caption">
          {peek.length === 0 ? (
            <li className="italic text-muted-foreground">
              {t(($) => $.active_board.waiting_for_activity)}
            </li>
          ) : (
            peek.map((step) => <PeekRow key={step.seq} step={step} />)
          )}
        </ul>
      )}
    </div>
  );
}

function StatusDot({ status, stale }: { status: AgentTask["status"]; stale: boolean }) {
  if (status === "running") {
    return (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          stale ? "bg-warning" : "animate-pulse bg-success",
        )}
      />
    );
  }
  if (status === "waiting_local_directory") {
    return <span className="size-1.5 shrink-0 rounded-full bg-warning" />;
  }
  // Queued and dispatched: hollow, so "not yet running" reads at a glance.
  return <span className="size-1.5 shrink-0 rounded-full border border-muted-foreground" />;
}

function PeekRow({ step }: { step: TraceStep }) {
  if (step.kind === "call") {
    return (
      <li className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 rounded bg-muted px-1 font-mono text-caption text-muted-foreground">
          {step.tool}
        </span>
        <span className="truncate text-foreground/80">
          {traceToolArgSummary(step.call?.input)}
        </span>
      </li>
    );
  }
  const text = stepText(step);
  return (
    <li
      className={cn("truncate", step.kind === "error" ? "text-destructive" : "text-foreground/80")}
      title={text}
    >
      {step.kind === "error" ? `✗ ${text}` : text}
    </li>
  );
}

function stepText(step: TraceStep): string {
  if (step.kind === "call") return "";
  return plainSummary(step.item.content ?? "");
}
