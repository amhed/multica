"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { hostHealthOptions } from "@multica/core/agents";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspacePaths } from "@multica/core/paths";
import { memberListOptions } from "@multica/core/workspace/queries";
import type { HostHealth, HostProcs } from "@multica/core/types";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { ReapDialog } from "./reap-dialog";
import { formatDurationMs } from "./tabs/activity-tab";
import {
  deriveHostStatus,
  formatKB,
  formatKBps,
  hasSaturationSignals,
  memUsedRatio,
  swapUsedRatio,
  type HostStatus,
} from "./host-health";

const STATUS_DOT: Record<HostStatus, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
};

const STATUS_BORDER: Record<HostStatus, string> = {
  green: "border",
  amber: "border-warning/50",
  red: "border-destructive/50",
};

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function ProcsUsage({ procs }: { procs: HostProcs }) {
  const { t } = useT("agents");
  return (
    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
      {t(($) => $.active_board.host.usage, {
        memory: formatKB(procs.rss_kb),
        cpu: `${Math.round(procs.cpu_pct)}%`,
      })}
    </span>
  );
}

// The command truncates; its age always stays visible.
function TopCmd({ procs }: { procs: HostProcs }) {
  if (!procs.top_cmd) return null;
  return (
    <div className="flex min-w-0 gap-1 font-mono text-muted-foreground">
      <span className="truncate" title={procs.top_cmd}>
        {procs.top_cmd}
      </span>
      <span className="shrink-0">· {formatDurationMs(procs.top_cmd_age_s * 1000)}</span>
    </div>
  );
}

// Where the host's memory and CPU are going: this workspace's running tasks,
// largest first, then processes no running task owns.
function HostTasks({ host }: { host: HostHealth }) {
  const { t } = useT("agents");
  const p = useWorkspacePaths();
  if (host.tasks.length === 0 && !host.stale) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-2 text-caption">
      {host.tasks.map((task) => (
        <li key={task.task_id} className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {task.issue_id && task.issue_identifier && (
              <AppLink
                href={p.issueDetail(task.issue_id)}
                className="shrink-0 font-mono text-label text-muted-foreground hover:underline"
              >
                {task.issue_identifier}
              </AppLink>
            )}
            <span className="truncate font-medium">{task.agent_name}</span>
            <ProcsUsage procs={task} />
          </div>
          <TopCmd procs={task} />
        </li>
      ))}
      {host.stale && (
        <li className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">
              {t(($) => $.active_board.host.stale, { count: host.stale.procs })}
            </span>
            <ProcsUsage procs={host.stale} />
          </div>
          <TopCmd procs={host.stale} />
        </li>
      )}
    </ul>
  );
}

function HostRow({
  host,
  canManageWorkspace,
}: {
  host: HostHealth;
  canManageWorkspace: boolean;
}) {
  const { t } = useT("agents");
  const status = deriveHostStatus(host);
  const [reapOpen, setReapOpen] = useState(false);
  // Without a daemon id the reap request has no route to target.
  const showReapAction = canManageWorkspace && status !== "green" && host.daemon_id !== "";
  return (
    <div
      className={cn(
        "@container flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4",
        STATUS_BORDER[status],
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])} aria-hidden />
        <span className="truncate text-body font-semibold">
          {host.device_name || t(($) => $.active_board.host.title)}
        </span>
        <span className="ml-auto shrink-0 text-caption text-muted-foreground">
          {t(($) => $.active_board.host.status[status])}
        </span>
      </div>
      <dl
        className={cn(
          "grid gap-3 text-caption",
          // Five metrics with rate values need two columns on a narrow card.
          hasSaturationSignals(host) ? "grid-cols-2 @sm:grid-cols-3" : "grid-cols-3",
        )}
      >
        {hasSaturationSignals(host) ? (
          <>
            <Metric
              label={t(($) => $.active_board.host.cpu)}
              value={host.cpu_busy_pct == null ? "–" : `${Math.round(host.cpu_busy_pct)}%`}
            />
            <Metric
              label={t(($) => $.active_board.host.load_1m)}
              value={`${host.load1.toFixed(2)} / ${host.ncpu}`}
            />
            <Metric label={t(($) => $.active_board.host.memory)} value={pct(memUsedRatio(host))} />
            <Metric
              label={t(($) => $.active_board.host.swap_activity)}
              value={`${formatKBps(host.swap_in_kbps ?? 0)} / ${formatKBps(host.swap_out_kbps ?? 0)}`}
            />
            {host.cgroup_mem_current_kb > 0 && (
              <Metric
                label={t(($) => $.active_board.host.agent_memory)}
                value={
                  host.cgroup_mem_limit_kb > 0
                    ? `${formatKB(host.cgroup_mem_current_kb)} / ${formatKB(host.cgroup_mem_limit_kb)}`
                    : formatKB(host.cgroup_mem_current_kb)
                }
              />
            )}
          </>
        ) : (
          <>
            <Metric
              label={t(($) => $.active_board.host.load)}
              value={`${host.load15.toFixed(2)} / ${host.ncpu}`}
            />
            <Metric label={t(($) => $.active_board.host.memory)} value={pct(memUsedRatio(host))} />
            <Metric label={t(($) => $.active_board.host.swap)} value={pct(swapUsedRatio(host))} />
          </>
        )}
      </dl>
      <HostTasks host={host} />
      {showReapAction && (
        <Button variant="outline" size="sm" onClick={() => setReapOpen(true)}>
          {t(($) => $.active_board.host.reap.action)}
        </Button>
      )}
      {reapOpen && (
        <ReapDialog daemonId={host.daemon_id} onClose={() => setReapOpen(false)} />
      )}
    </div>
  );
}

/**
 * Machine-wide health of the daemon host(s) serving this workspace, pinned
 * above the Active grid. It polls its own endpoint (host metrics do not ride
 * the task-event WebSocket). An empty list renders a muted "unavailable" line
 * rather than an error, so a workspace with no connected daemon degrades
 * quietly.
 */
export function HealthCard({ wsId }: { wsId: string }) {
  const { t } = useT("agents");
  const { data, isLoading } = useQuery(hostHealthOptions(wsId));
  const user = useAuthStore((s) => s.user);
  const { data: members = [], isFetched: membersFetched } = useQuery(memberListOptions(wsId));
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  // Gated on the member query having settled so the action doesn't flash in
  // for a member before their role is known (mirrors WorkspaceTab).
  const canManageWorkspace =
    membersFetched &&
    (currentMember?.role === "owner" || currentMember?.role === "admin");

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }

  const hosts = data?.hosts ?? [];
  if (hosts.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4 text-caption text-muted-foreground">
        {t(($) => $.active_board.host.unavailable)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-2">
      {hosts.map((host) => (
        <HostRow key={host.daemon_id} host={host} canManageWorkspace={canManageWorkspace} />
      ))}
    </div>
  );
}
