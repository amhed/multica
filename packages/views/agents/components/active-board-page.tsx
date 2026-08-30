"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { LIST_GRID_BOTTOM_CLEARANCE } from "@multica/ui/components/ui/list-grid";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { CollectionPageHeader } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";
import { selectActiveTasks } from "./active-board";
import { ActiveTaskCard } from "./active-task-card";

const GRID_CLASS = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

/** Live board of every task an agent is working on right now. */
export function ActiveBoardPage() {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: snapshot = [], isLoading } = useQuery(agentTaskSnapshotOptions(wsId));
  const tasks = useMemo(() => selectActiveTasks(snapshot), [snapshot]);

  return (
    <div className="flex h-full flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.active_board.title)}
        count={tasks.length}
        description={t(($) => $.active_board.tagline)}
      />
      <div className={cn("min-h-0 flex-1 overflow-y-auto pt-4", PAGE_GUTTER)}>
        {isLoading ? (
          <div className={GRID_CLASS}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full rounded-md" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <p className="pt-16 text-center text-caption text-muted-foreground">
            {t(($) => $.active_board.empty)}
          </p>
        ) : (
          <div className={GRID_CLASS} style={{ paddingBottom: LIST_GRID_BOTTOM_CLEARANCE }}>
            {tasks.map((task) => (
              <ActiveTaskCard key={task.id} wsId={wsId} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
