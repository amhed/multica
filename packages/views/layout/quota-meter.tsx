"use client";

import { useQuery } from "@tanstack/react-query";
import type { QuotaProvider, QuotaResource, QuotaSnapshot } from "@multica/core/api/schemas";
import { quotaOptions } from "@multica/core/quota/queries";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@multica/ui/components/ui/hover-card";
import { Progress, ProgressLabel, ProgressValue } from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { ProviderLogo } from "../runtimes/components/provider-logo";

/**
 * Compact, always-visible strip showing how much of each AI provider's quota
 * is spent: a logo per provider with one figure per consumption window
 * (session over weekly when both exist). Hovering opens the full breakdown.
 *
 * Fed by the host-side collector snapshot relayed at GET /api/quota. Renders
 * nothing when the server has no snapshot, so deployments without a collector
 * see no empty box. Balance resources (credits) stand in only for providers
 * without a consumption window. Unknown resource kinds are skipped rather
 * than guessed at.
 */
export function QuotaMeter({ className }: { className?: string }) {
  const { t } = useT("layout");
  const { data } = useQuery(quotaOptions());
  const snapshot = data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
  const entries = providerEntries(snapshot);
  if (!snapshot || entries.length === 0) return null;

  return (
    <HoverCard>
      <HoverCardTrigger
        render={<button type="button" />}
        aria-label={t(($) => $.sidebar.quota.title)}
        className={cn(
          "flex min-w-0 cursor-default items-center gap-3 rounded-md px-1.5 py-1 tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          snapshot.stale === true && "opacity-60",
          className,
        )}
      >
        {entries.map(([key, provider]) => (
          <CompactProvider key={key} providerKey={key} provider={provider} />
        ))}
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-64">
        <QuotaDetails snapshot={snapshot} />
      </HoverCardContent>
    </HoverCard>
  );
}

function CompactProvider({ providerKey, provider }: { providerKey: string; provider: QuotaProvider }) {
  const resources = Object.entries(provider.resources ?? {});
  const figures = resources.flatMap(([key, r]) => {
    if (r.kind !== "consumption") return [];
    const percent = utilizationPercent(r);
    return percent === null ? [] : [{ key, text: `${Math.round(percent)}%`, className: thresholdTextClass(percent) }];
  });
  if (figures.length === 0) {
    const balance = resources.find(([, r]) => r.kind === "balance");
    if (balance) figures.push({ key: balance[0], text: formatNumber(balance[1].available), className: null });
  }
  if (figures.length === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-1" title={provider.displayName}>
      <ProviderLogo provider={providerKey} className="size-3.5 shrink-0" />
      <span className={cn("flex flex-col", figures.length > 1 ? "items-end text-micro leading-none" : "text-caption font-medium")}>
        {figures.map((f) => (
          <span key={f.key} className={cn(f.className)}>
            {f.text}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Full per-window breakdown: bars, reset times on hover, and balances. */
export function QuotaDetails({ snapshot }: { snapshot: QuotaSnapshot }) {
  const { t } = useT("layout");
  const entries = providerEntries(snapshot);

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
    <div className="flex flex-col gap-2 text-caption">
      {snapshot.stale === true && (
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

function providerEntries(snapshot: QuotaSnapshot | undefined): [string, QuotaProvider][] {
  if (!snapshot?.providers) return [];
  return Object.entries(snapshot.providers).filter(([, p]) => Object.keys(p.resources ?? {}).length > 0);
}

function thresholdTextClass(percent: number): string | null {
  return percent >= 90 ? "text-destructive" : percent >= 75 ? "text-warning" : null;
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
        <span className="truncate font-medium">{provider.displayName}</span>
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
    // `Progress` renders its own track + indicator after `children`, so the
    // indicator is recolored from the root rather than by adding a second track.
    <Progress
      value={percent}
      title={title}
      className={cn(
        "gap-x-2 gap-y-0.5",
        percent >= 90
          ? "[&_[data-slot=progress-indicator]]:bg-destructive"
          : percent >= 75
            ? "[&_[data-slot=progress-indicator]]:bg-warning"
            : null,
      )}
    >
      <ProgressLabel className="text-caption font-normal text-muted-foreground">{label}</ProgressLabel>
      <ProgressValue className="text-caption">{() => `${Math.round(percent)}%`}</ProgressValue>
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
