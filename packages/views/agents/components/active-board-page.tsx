"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { LIST_GRID_BOTTOM_CLEARANCE } from "@multica/ui/components/ui/list-grid";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { issueDetailOptions } from "@multica/core/issues";
import { CollectionPageHeader } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { activeCounts, groupActiveTasks, selectActiveTasks, type ActiveTaskGroup } from "./active-board";
import { ActiveTaskCard } from "./active-task-card";

const LIST_CLASS = "flex max-w-4xl flex-col gap-6";

/** Live board of every task an agent is working on right now, grouped by issue. */
export function ActiveBoardPage() {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: snapshot = [], isLoading } = useQuery(agentTaskSnapshotOptions(wsId));
  const tasks = useMemo(() => selectActiveTasks(snapshot), [snapshot]);
  const groups = useMemo(() => groupActiveTasks(tasks), [tasks]);
  const counts = activeCounts(tasks);

  const description =
    tasks.length === 0
      ? undefined
      : [
          t(($) => $.active_board.running_count, { count: counts.running }),
          counts.waiting > 0 ? t(($) => $.active_board.waiting_count, { count: counts.waiting }) : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.active_board.title)}
        count={tasks.length}
        description={description}
      />
      <div className={cn("min-h-0 flex-1 overflow-y-auto pt-4", PAGE_GUTTER)}>
        {isLoading ? (
          <div className={LIST_CLASS}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-md" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <p className="pt-16 text-center text-caption text-muted-foreground">
            {t(($) => $.active_board.empty)}
          </p>
        ) : (
          <div className={LIST_CLASS} style={{ paddingBottom: LIST_GRID_BOTTOM_CLEARANCE }}>
            {groups.map((group) => (
              <IssueGroup key={group.key} wsId={wsId} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Issue title as the primary line, then one card per task working on it. */
function IssueGroup({ wsId, group }: { wsId: string; group: ActiveTaskGroup }) {
  const { t } = useT("agents");
  const p = useWorkspacePaths();
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, group.issueId),
    enabled: !!group.issueId,
  });

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="min-w-0 text-body-lg">
        {group.issueId ? (
          issue ? (
            <AppLink
              href={p.issueDetail(group.issueId)}
              className="flex min-w-0 items-baseline gap-2 hover:underline"
              title={`${issue.identifier} ${issue.title}`}
            >
              <span className="shrink-0 font-mono text-body text-muted-foreground">
                {issue.identifier}
              </span>
              <span className="truncate font-medium">{issue.title}</span>
            </AppLink>
          ) : (
            <Skeleton className="h-4 w-64" />
          )
        ) : (
          <span className="text-muted-foreground">{t(($) => $.active_board.no_issue)}</span>
        )}
      </h2>
      <div className="flex flex-col gap-2">
        {group.tasks.map((task) => (
          <ActiveTaskCard key={task.id} wsId={wsId} task={task} />
        ))}
      </div>
    </section>
  );
}
