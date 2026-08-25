"use client";

import { useQuery } from "@tanstack/react-query";
import type { QuotaProvider, QuotaResource } from "@multica/core/api/schemas";
import { quotaOptions } from "@multica/core/quota/queries";
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";

/**
 * Sidebar footer strip showing how much of each AI provider's quota is spent.
 *
 * Fed by the host-side collector snapshot relayed at GET /api/quota. Renders
 * nothing when the server has no snapshot, so deployments without a collector
 * see no empty box. Consumption windows (session, weekly) become bars;
 * balance resources (credits) become a single number. Unknown resource kinds
 * are skipped rather than guessed at.
 */
export function QuotaMeter() {
  const { t } = useT("layout");
  const { data } = useQuery(quotaOptions());
  const providers = data && typeof data === "object" && !Array.isArray(data) ? data.providers : undefined;
  if (!providers) return null;
  const entries = Object.entries(providers).filter(([, p]) => Object.keys(p.resources ?? {}).length > 0);
  if (entries.length === 0) return null;

  const resourceLabel = (key: string) => {
    switch (key) {
      case "session":
        return t(($) => $.sidebar.quota.session);
      case "weekly":
        return t(($) => $.sidebar.quota.weekly);
      case "credits":
      case "extraUsage":
        return t(($) => $.sidebar.quota.credits);
      default:
        return key;
    }
  };

  return (
    <div className="flex flex-col gap-2 px-2 pb-2 text-caption">
      {data?.stale === true && (
        <span className="text-muted-foreground">{t(($) => $.sidebar.quota.stale)}</span>
      )}
      {entries.map(([key, provider]) => (
        <ProviderRow
          key={key}
          provider={provider}
          resourceLabel={resourceLabel}
          resetsLabel={(when) => t(($) => $.sidebar.quota.resets, { when })}
        />
      ))}
    </div>
  );
}

function ProviderRow({
  provider,
  resourceLabel,
  resetsLabel,
}: {
  provider: QuotaProvider;
  resourceLabel: (key: string) => string;
  resetsLabel: (when: string) => string;
}) {
  const resources = Object.entries(provider.resources ?? {});
  const consumption = resources.filter(([, r]) => r.kind === "consumption");
  const balances = resources.filter(([, r]) => r.kind === "balance");
  if (consumption.length === 0 && balances.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium text-sidebar-foreground">{provider.displayName}</span>
        {consumption.length === 0 && balances[0] && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatNumber(balances[0][1].available)} {resourceLabel(balances[0][0])}
          </span>
        )}
      </div>
      {consumption.map(([key, resource]) => (
        <ConsumptionBar
          key={key}
          label={resourceLabel(key)}
          resource={resource}
          resetsLabel={resetsLabel}
        />
      ))}
    </div>
  );
}

function ConsumptionBar({
  label,
  resource,
  resetsLabel,
}: {
  label: string;
  resource: QuotaResource;
  resetsLabel: (when: string) => string;
}) {
  const percent = utilizationPercent(resource);
  if (percent === null) return null;
  const resetsAt = resource.resetsAt ? new Date(resource.resetsAt) : null;
  const title =
    resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsLabel(resetsAt.toLocaleString()) : undefined;

  return (
    <Progress
      value={percent}
      title={title}
      className="gap-x-2 gap-y-0.5"
    >
      <ProgressLabel className="text-caption font-normal text-muted-foreground">{label}</ProgressLabel>
      <ProgressValue className="text-caption">{() => `${Math.round(percent)}%`}</ProgressValue>
      <ProgressTrack>
        <ProgressIndicator
          className={cn(
            percent >= 90 ? "bg-destructive" : percent >= 75 ? "bg-warning" : "bg-primary",
          )}
        />
      </ProgressTrack>
    </Progress>
  );
}

/** Percent of the window consumed, from whichever field the collector filled. */
function utilizationPercent(r: QuotaResource): number | null {
  let pct: number | null = null;
  if (typeof r.utilization === "number") pct = r.utilization * 100;
  else if (typeof r.used === "number" && typeof r.limit === "number" && r.limit > 0) {
    pct = (r.used / r.limit) * 100;
  } else if (typeof r.used === "number" && r.unit === "percent") pct = r.used;
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

function formatNumber(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "–";
}
