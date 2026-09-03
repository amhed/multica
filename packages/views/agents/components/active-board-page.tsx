"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { LIST_GRID_BOTTOM_CLEARANCE } from "@multica/ui/components/ui/list-grid";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import type { AgentTask } from "@multica/core/types";
import { CollectionPageHeader } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { buildTimeline } from "../../common/task-transcript/build-timeline";
import { buildSteps, type TraceStep } from "../../common/task-transcript/build-steps";
import { useT } from "../../i18n";
import {
  activeCounts,
  isWaitingForInput,
  selectBoardTasks,
  sortBoardCards,
  type BoardCard,
} from "./active-board";
import { ActiveTaskCard } from "./active-task-card";
import { AgentWindow } from "./agent-window";

const TASK_PARAM = "task";
const GRID_CLASS = "grid grid-cols-1 gap-4 md:grid-cols-2";

/**
 * Every agent working, or recently blocked on a person, as one grid of cards.
 * Clicking a card opens the agent window; the open task lives in `?task=` so
 * it survives a reload and can be linked.
 */
export function ActiveBoardPage() {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const nav = useNavigation();
  const { data: snapshot = [], isLoading } = useQuery(agentTaskSnapshotOptions(wsId));
  const candidates = useMemo(() => selectBoardTasks(snapshot), [snapshot]);

  // Holding a running task's messages cache is what lets its task:message
  // stream flow (MUL-6396). Recently finished tasks are fetched once so the
  // board can tell whether their last words were a question.
  const messageQueries = useQueries({
    queries: candidates.map((task) => ({
      ...taskMessagesOptions(task.id),
      enabled: taskMessagesOptions(task.id).enabled !== false,
    })),
  });

  const stepsByTask = useMemo(() => {
    const out = new Map<string, TraceStep[]>();
    candidates.forEach((task, i) => {
      const messages = (messageQueries[i]?.data ?? []) as Parameters<typeof buildTimeline>[0];
      out.set(task.id, buildSteps(buildTimeline(messages)).filter((s) => s.kind !== "thinking"));
    });
    return out;
  }, [candidates, messageQueries]);

  const cards = useMemo(() => {
    const now = Date.now();
    const unsorted: BoardCard[] = candidates.map((task) => {
      const steps = stepsByTask.get(task.id) ?? [];
      const last = steps.at(-1);
      return {
        task,
        waiting: isWaitingForInput(task, steps, now),
        lastActivityAt: last?.startedAt ?? (last?.kind === "call" ? last.endedAt ?? null : null),
      };
    });
    return sortBoardCards(unsorted);
  }, [candidates, stepsByTask]);

  const openTaskId = nav.searchParams.get(TASK_PARAM);
  const openTask: AgentTask | null = useMemo(
    () => cards.find((c) => c.task.id === openTaskId)?.task ?? null,
    [cards, openTaskId],
  );

  const setTaskParam = useCallback(
    (taskId: string | null) => {
      const params = new URLSearchParams(nav.searchParams);
      if (taskId) params.set(TASK_PARAM, taskId);
      else params.delete(TASK_PARAM);
      const search = params.toString();
      nav.replace(`${nav.pathname}${search ? `?${search}` : ""}`);
    },
    [nav],
  );

  // A stale or unknown ?task= is cleared rather than shown as an empty window.
  useEffect(() => {
    if (!isLoading && openTaskId && !openTask) setTaskParam(null);
  }, [isLoading, openTaskId, openTask, setTaskParam]);

  const active = cards.filter((c) => !c.waiting).map((c) => c.task);
  const counts = activeCounts(active);
  const waitingCount = cards.length - active.length;
  const description =
    cards.length === 0
      ? undefined
      : [
          t(($) => $.active_board.running_count, { count: counts.running }),
          counts.waiting > 0 ? t(($) => $.active_board.waiting_count, { count: counts.waiting }) : null,
          waitingCount > 0 ? `${waitingCount} ${t(($) => $.active_board.waiting_for_you).toLowerCase()}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.active_board.title)}
        count={cards.length}
        description={description}
      />
      <div className={cn("min-h-0 flex-1 overflow-y-auto pt-4", PAGE_GUTTER)}>
        {isLoading ? (
          <div className={GRID_CLASS}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <p className="pt-16 text-center text-caption text-muted-foreground">{t(($) => $.active_board.empty)}</p>
        ) : (
          <div className={GRID_CLASS} style={{ paddingBottom: LIST_GRID_BOTTOM_CLEARANCE }}>
            {cards.map((card) => (
              <ActiveTaskCard
                key={card.task.id}
                wsId={wsId}
                card={card}
                lastStep={stepsByTask.get(card.task.id)?.at(-1) ?? null}
                onOpen={(id) => setTaskParam(id)}
              />
            ))}
          </div>
        )}
      </div>
      <AgentWindow wsId={wsId} task={openTask} onClose={() => setTaskParam(null)} />
    </div>
  );
}
