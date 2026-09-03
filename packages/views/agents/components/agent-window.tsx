"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentListOptions } from "@multica/core/workspace/queries";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { AgentTranscriptDialog } from "../../common/task-transcript/agent-transcript-dialog";
import { buildTimeline } from "../../common/task-transcript/build-timeline";

export interface AgentWindowProps {
  wsId: string;
  /** The task to show; null closes the window. */
  task: AgentTask | null;
  onClose: () => void;
}

/**
 * A board card opened: the task's transcript, over the grid. The board is a
 * read-only lens, so this is the shared transcript dialog with no composer;
 * replies go through the issue. It opens at the latest step so a run's
 * current activity, or its closing question, is the first thing seen.
 */
export function AgentWindow({ wsId, task, onClose }: AgentWindowProps) {
  if (!task) return null;
  return (
    <AgentWindowBody key={task.id} wsId={wsId} task={task} onClose={onClose} />
  );
}

function AgentWindowBody({
  wsId,
  task,
  onClose,
}: {
  wsId: string;
  task: AgentTask;
  onClose: () => void;
}) {
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === task.agent_id);
  const { data: messages = [] } = useQuery(taskMessagesOptions(task.id));
  const items = useMemo(() => buildTimeline(messages), [messages]);

  return (
    <AgentTranscriptDialog
      open
      onOpenChange={(open) => !open && onClose()}
      task={task}
      items={items}
      agentName={agent?.name ?? ""}
      isLive={task.status === "running"}
      startAtEnd
    />
  );
}
