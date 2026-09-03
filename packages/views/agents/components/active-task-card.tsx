"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { agentListOptions } from "@multica/core/workspace/queries";
import { issueDetailOptions } from "@multica/core/issues";
import { useWorkspacePaths } from "@multica/core/paths";
import type { AgentTask } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import type { TraceStep } from "../../common/task-transcript/build-steps";
import { TranscriptButton } from "../../common/task-transcript/transcript-button";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import {
  describeStep,
  isStale,
  plainSummary,
  taskSummary,
  type BoardCard,
} from "./active-board";

export interface ActiveTaskCardProps {
  wsId: string;
  card: BoardCard;
  /** Latest non-thinking transcript step; null when the run has none yet. */
  lastStep: TraceStep | null;
  onOpen: (taskId: string) => void;
  onStop?: (taskId: string) => void;
}

type ActiveStatus =
  | "running"
  | "waiting_local_directory"
  | "dispatched"
  | "queued";

/**
 * One agent on the Active grid: who, on which issue, the generated headline,
 * and one line for what it is doing right now. The whole card opens the agent
 * window; the footer actions do not.
 */
export function ActiveTaskCard({
  wsId,
  card,
  lastStep,
  onOpen,
  onStop,
}: ActiveTaskCardProps) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const p = useWorkspacePaths();
  const { task, waiting, lastActivityAt } = card;
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === task.agent_id);
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, task.issue_id),
    enabled: !!task.issue_id,
  });
  const isRunning = task.status === "running";

  const summary = taskSummary(task);
  const headline =
    summary.source === "kind"
      ? t(($) => $.active_board.kind[summary.kind])
      : plainSummary(summary.text);

  const startedAt = task.started_at ?? task.dispatched_at ?? task.created_at;
  const stale = isRunning && isStale(lastActivityAt ?? startedAt);
  const description = lastStep ? describeStep(lastStep) : null;

  return (
    <div
      onClick={() => onOpen(task.id)}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/40",
        waiting && "border-warning/40",
      )}
    >
      <div className="flex items-center gap-2.5">
        <ActorAvatar
          actorType="agent"
          actorId={task.agent_id}
          size="sm"
          profileLink={false}
        />
        {agent ? (
          <span className="truncate text-body font-semibold">{agent.name}</span>
        ) : (
          <Skeleton className="h-4 w-24" />
        )}
        {task.issue_id &&
          (issue ? (
            <AppLink
              href={p.issueDetail(task.issue_id)}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="truncate font-mono text-label text-muted-foreground hover:underline"
              title={issue.title}
            >
              {issue.identifier}
            </AppLink>
          ) : (
            <Skeleton className="h-4 w-16" />
          ))}
        <StatusPill
          task={task}
          waiting={waiting}
          stale={stale}
          startedAt={startedAt}
        />
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(task.id);
        }}
        className="line-clamp-3 text-left text-body text-foreground hover:underline focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 rounded-sm"
        aria-label={headline}
      >
        {headline}
      </button>

      {(isRunning || waiting) && (
        <div
          className={cn(
            "flex min-w-0 items-baseline gap-2 text-label",
            stale
              ? "text-warning"
              : description?.tone === "error"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 self-center rounded-full",
              stale || waiting ? "bg-warning" : "animate-pulse bg-success",
            )}
          />
          <span className="min-w-0 flex-1 truncate">
            {stale && lastActivityAt
              ? t(($) => $.active_board.stale_for, {
                  ago: timeAgo(lastActivityAt),
                })
              : description
                ? t(($) => $.active_board.step[description.verb], {
                    object: description.object,
                  })
                : t(($) => $.active_board.waiting_for_activity)}
          </span>
          {lastActivityAt && (
            <span className="shrink-0 font-mono text-caption text-muted-foreground">
              {timeAgo(lastActivityAt)}
            </span>
          )}
        </div>
      )}

      <div
        className="flex items-center gap-2 pt-1"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-caption text-muted-foreground">
          {t(($) => $.active_board.click_to_open)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {task.issue_id && (
            <Button
              variant="secondary"
              size="sm"
              render={<AppLink href={p.issueDetail(task.issue_id)} />}
              nativeButton={false}
            >
              {t(($) => $.active_board.open_issue)}
            </Button>
          )}
          {agent && (
            <TranscriptButton
              task={task}
              agentName={agent.name}
              isLive={isRunning}
              title={t(($) => $.active_board.view_transcript)}
            />
          )}
          {waiting ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpen(task.id)}
            >
              {t(($) => $.active_board.reply)}
            </Button>
          ) : (
            onStop &&
            isRunning && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => onStop(task.id)}
              >
                {t(($) => $.active_board.stop)}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  task,
  waiting,
  stale,
  startedAt,
}: {
  task: AgentTask;
  waiting: boolean;
  stale: boolean;
  startedAt: string;
}) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const tone =
    waiting || stale
      ? "bg-warning/15 text-warning"
      : task.status === "running"
        ? "bg-success/15 text-success"
        : "bg-muted text-muted-foreground";
  const label = waiting
    ? t(($) => $.active_board.waiting_for_you)
    : task.status === "completed"
      ? t(($) => $.active_board.completed_ago, {
          ago: timeAgo(task.completed_at ?? startedAt),
        })
      : `${t(($) => $.active_board.status[task.status as ActiveStatus])} · ${timeAgo(startedAt)}`;
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-caption font-medium",
        tone,
      )}
    >
      {label}
    </span>
  );
}
