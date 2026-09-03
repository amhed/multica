"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { agentListOptions } from "@multica/core/workspace/queries";
import { issueDetailOptions, useCreateComment } from "@multica/core/issues";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { buildTimeline } from "../../common/task-transcript/build-timeline";
import { buildSteps } from "../../common/task-transcript/build-steps";
import { TranscriptButton } from "../../common/task-transcript/transcript-button";
import { useT, useTimeAgo } from "../../i18n";
import { describeStep, plainSummary, taskSummary } from "./active-board";
import {
  buildConversation,
  type ConversationBlock,
} from "./agent-window-conversation";

export interface AgentWindowProps {
  wsId: string;
  /** The task to show; null closes the window. */
  task: AgentTask | null;
  onClose: () => void;
}

/**
 * A task's transcript read as a conversation with the agent, over the grid.
 * The composer posts an issue comment, which is how a person reaches an agent
 * in Multica; while the run is live it is disabled, since a comment cannot
 * join a run in progress.
 */
export function AgentWindow({ wsId, task, onClose }: AgentWindowProps) {
  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      {task && <AgentWindowBody key={task.id} wsId={wsId} task={task} />}
    </Dialog>
  );
}

function AgentWindowBody({ wsId, task }: { wsId: string; task: AgentTask }) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const isRunning = task.status === "running";
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === task.agent_id);
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, task.issue_id),
    enabled: !!task.issue_id,
  });
  const { data: messages = [] } = useQuery(taskMessagesOptions(task.id));

  const steps = useMemo(() => buildSteps(buildTimeline(messages)), [messages]);
  const blocks = useMemo(() => buildConversation(steps), [steps]);
  const current = useMemo(() => {
    const last = steps.filter((s) => s.kind !== "thinking").at(-1);
    return last ? describeStep(last) : null;
  }, [steps]);

  const summary = taskSummary(task);
  const trigger =
    summary.source === "kind"
      ? t(($) => $.active_board.kind[summary.kind])
      : plainSummary(summary.text);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Follow the live end while it is within reach; a reader scrolled up stays put.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120)
      el.scrollTop = el.scrollHeight;
  }, [blocks.length, current?.object]);

  const [draft, setDraft] = useState("");
  const createComment = useCreateComment(task.issue_id);
  const canSend =
    !isRunning &&
    !!task.issue_id &&
    draft.trim().length > 0 &&
    !createComment.isPending;
  const send = () => {
    if (!canSend) return;
    createComment.mutate(
      { content: draft.trim() },
      {
        onSuccess: () => {
          setDraft("");
          // Send disables itself once the draft is empty, which would hand
          // focus to the next control; keep the reader in the composer.
          composerRef.current?.focus();
        },
      },
    );
  };

  const agentName = agent?.name ?? "";
  const issueLabel = issue?.identifier ?? "";

  return (
    <DialogContent
      className="!max-w-[920px] !w-[calc(100vw-4rem)] !max-h-[calc(100vh-4rem)] !h-[760px] flex flex-col !p-0 !gap-0 overflow-hidden"
      showCloseButton
    >
      <DialogTitle className="sr-only">
        {t(($) => $.active_board.window.title, {
          agent: agentName,
          issue: issueLabel,
        })}
      </DialogTitle>

      <div className="flex items-center gap-3 border-b px-5 py-4">
        <ActorAvatar
          actorType="agent"
          actorId={task.agent_id}
          size="md"
          profileLink={false}
        />
        <div className="flex min-w-0 flex-col">
          <span className="text-body-lg font-semibold">{agentName}</span>
          <span className="truncate text-label text-muted-foreground">
            {issue
              ? `${issue.identifier} · ${issue.title}`
              : t(($) => $.active_board.no_issue)}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
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

      <div
        ref={scrollerRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto [&>*]:shrink-0 px-5 py-5"
      >
        <div className="flex max-w-[70%] flex-col items-end gap-1 self-end">
          <span className="text-micro text-muted-foreground">
            {t(($) => $.active_board.window.trigger_label_unknown)}{" "}
            {timeAgo(task.created_at)}
          </span>
          <div className="rounded-2xl rounded-br-sm bg-accent px-3.5 py-2.5 text-body">
            {trigger}
          </div>
        </div>

        {blocks.map((block) => (
          <Block key={`${block.kind}-${block.seq}`} block={block} />
        ))}

        {isRunning && current && (
          <div className="flex items-center gap-2 px-3.5 py-1.5 text-label text-muted-foreground">
            <span className="size-1.5 rounded-full bg-muted-foreground" />
            <span className="size-1.5 rounded-full bg-muted-foreground/60" />
            <span className="size-1.5 rounded-full bg-muted-foreground/30" />
            <span className="truncate">
              {t(($) => $.active_board.step[current.verb], {
                object: current.object,
              })}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t px-5 py-4">
        <Textarea
          ref={composerRef}
          aria-label={t(($) => $.active_board.window.composer_placeholder, {
            issue: issueLabel,
            agent: agentName,
          })}
          placeholder={t(($) => $.active_board.window.composer_placeholder, {
            issue: issueLabel,
            agent: agentName,
          })}
          value={draft}
          disabled={isRunning || !task.issue_id}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
          rows={2}
        />
        <div className="flex items-center gap-3">
          {isRunning && (
            <span className="text-caption text-muted-foreground">
              {t(($) => $.active_board.window.composer_running_hint)}
            </span>
          )}
          <Button
            size="sm"
            className="ml-auto"
            disabled={!canSend}
            onClick={send}
          >
            {t(($) => $.active_board.window.send)}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function Block({ block }: { block: ConversationBlock }) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  switch (block.kind) {
    case "agent_text":
      return (
        <div className="max-w-[75%] self-start rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 text-body">
          {block.text}
        </div>
      );
    case "error":
      return (
        <div className="max-w-[75%] self-start rounded-2xl rounded-bl-sm border border-destructive/40 px-3.5 py-2.5 text-body text-destructive">
          {block.text}
        </div>
      );
    case "files":
      return (
        <div className="w-[520px] max-w-full self-start overflow-hidden rounded-lg border bg-card">
          <div className="border-b px-3.5 py-2.5 text-label font-medium">
            {t(($) => $.active_board.window.files_changed, {
              count: block.paths.length,
            })}
          </div>
          <ul className="flex flex-col gap-1 px-3.5 py-2.5 font-mono text-caption text-muted-foreground">
            {block.paths.map((p) => (
              <li key={p} className="truncate">
                {p}
              </li>
            ))}
          </ul>
        </div>
      );
    case "commands":
      return (
        <div className="flex w-[520px] max-w-full flex-col self-start gap-1.5">
          {block.runs.map((run) => (
            <div
              key={run.seq}
              className="flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  run.ok === true
                    ? "bg-success"
                    : run.ok === false
                      ? "bg-destructive"
                      : "bg-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-caption">
                {run.command}
              </span>
            </div>
          ))}
        </div>
      );
    case "other":
      return (
        <div className="self-start">
          <button
            type="button"
            className="text-caption text-muted-foreground hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {t(($) => $.active_board.window.other_steps, {
              count: block.steps.length,
            })}
          </button>
          {open && (
            <ul className="mt-1 flex flex-col gap-0.5 pl-2 text-caption text-muted-foreground">
              {block.steps.map((s, i) => (
                <li key={i} className="truncate">
                  {t(($) => $.active_board.step[s.verb], { object: s.object })}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    default:
      return null;
  }
}
