"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentListOptions } from "@multica/core/workspace/queries";
import { issueDetailOptions } from "@multica/core/issues";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { buildTimeline, type TimelineItem } from "../../common/task-transcript/build-timeline";
import { traceToolArgSummary } from "../../common/task-transcript/trace-event-presenter";
import { TranscriptButton } from "../../common/task-transcript/transcript-button";
import { taskSummary } from "./active-board";

const PEEK_ITEMS = 3;

type ActiveStatus = "running" | "waiting_local_directory" | "dispatched" | "queued";

const STATUS_DOT: Record<string, string> = {
  running: "bg-success",
  waiting_local_directory: "bg-warning",
  dispatched: "bg-muted-foreground",
  queued: "bg-muted-foreground",
};

interface ActiveTaskCardProps {
  wsId: string;
  task: AgentTask;
}

/**
 * One card per active task: who is working, on which issue, what the task is
 * about, and a live peek at the last few transcript events.
 */
export function ActiveTaskCard({ wsId, task }: ActiveTaskCardProps) {
  const { t } = useT("agents");
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, task.issue_id),
    enabled: !!task.issue_id,
  });
  const agent = agents.find((a) => a.id === task.agent_id);
  const isRunning = task.status === "running";

  // Holding this cache entry is what lets the WS `task:message` stream flow
  // for the task (MUL-6396), so it is mounted only while the task runs.
  const { data: messages = [] } = useQuery({
    ...taskMessagesOptions(task.id),
    enabled: isRunning && taskMessagesOptions(task.id).enabled,
  });
  const peek = useMemo(
    () => buildTimeline(messages).slice(-PEEK_ITEMS),
    [messages],
  );

  const summary = taskSummary(task);
  const summaryText =
    summary.source === "kind"
      ? t(($) => $.active_board.kind[summary.kind])
      : summary.text;
  const startedAt = task.started_at ?? task.dispatched_at ?? task.created_at;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <ActorAvatar actorType="agent" actorId={task.agent_id} size="sm" profileLink={false} />
        <div className="min-w-0 flex-1">
          {agent ? (
            <p className="truncate text-body font-medium">{agent.name}</p>
          ) : (
            <Skeleton className="h-4 w-24" />
          )}
          <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[task.status] ?? "bg-muted-foreground")}
            />
            <span>{t(($) => $.active_board.status[task.status as ActiveStatus])}</span>
            <span>·</span>
            <span>{timeAgo(startedAt)}</span>
          </p>
        </div>
        {agent && (
          <TranscriptButton
            task={task}
            agentName={agent.name}
            isLive={isRunning}
            title={t(($) => $.active_board.view_transcript)}
          />
        )}
      </div>

      <div className="min-w-0 text-caption">
        {task.issue_id ? (
          issue ? (
            <AppLink
              href={p.issueDetail(task.issue_id)}
              className="block truncate text-brand hover:underline"
              title={`${issue.identifier} ${issue.title}`}
            >
              <span className="mr-1 font-mono text-micro">{issue.identifier}</span>
              <span>{issue.title}</span>
            </AppLink>
          ) : (
            <Skeleton className="h-3 w-40" />
          )
        ) : (
          <span className="text-muted-foreground">{t(($) => $.active_board.no_issue)}</span>
        )}
      </div>

      <p className="line-clamp-2 text-caption text-muted-foreground" title={summaryText}>
        {summaryText}
      </p>

      {isRunning && (
        <ul className="flex flex-col gap-1 border-t pt-2 text-micro text-muted-foreground">
          {peek.length === 0 ? (
            <li className="italic">{t(($) => $.active_board.waiting_for_activity)}</li>
          ) : (
            peek.map((item) => (
              <li key={item.seq} className="truncate font-mono">
                {peekLine(item)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function peekLine(item: TimelineItem): string {
  switch (item.type) {
    case "tool_use":
      return `${item.tool ?? "tool"} ${traceToolArgSummary(item.input)}`.trim();
    case "tool_result":
      return `↳ ${(item.output ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
    case "error":
      return `✗ ${(item.content ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
    default:
      return (item.content ?? "").replace(/\s+/g, " ").slice(0, 120);
  }
}
