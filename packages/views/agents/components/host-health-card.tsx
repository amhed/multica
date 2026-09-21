"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { hostHealthOptions } from "@multica/core/agents";
import type { HostHealth } from "@multica/core/types";
import { useT } from "../../i18n";
import {
  deriveHostStatus,
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

function HostRow({ host }: { host: HostHealth }) {
  const { t } = useT("agents");
  const status = deriveHostStatus(host);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4",
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
      <dl className="grid grid-cols-3 gap-3 text-caption">
        <Metric
          label={t(($) => $.active_board.host.load)}
          value={`${host.load15.toFixed(2)} / ${host.ncpu}`}
        />
        <Metric label={t(($) => $.active_board.host.memory)} value={pct(memUsedRatio(host))} />
        <Metric label={t(($) => $.active_board.host.swap)} value={pct(swapUsedRatio(host))} />
      </dl>
    </div>
  );
}

/**
 * Machine-wide health of the daemon host(s) serving this workspace, pinned
 * above the Active grid. It polls its own endpoint (host metrics do not ride
 * the task-event WebSocket). An empty list renders a muted "unavailable" line
 * rather than an error, so a workspace with no connected daemon degrades
 * quietly. The expandable per-process detail is a planned phase-2 addition.
 */
export function HealthCard({ wsId }: { wsId: string }) {
  const { t } = useT("agents");
  const { data, isLoading } = useQuery(hostHealthOptions(wsId));

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
        <HostRow key={host.daemon_id} host={host} />
      ))}
    </div>
  );
}
