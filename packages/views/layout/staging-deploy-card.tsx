"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleX, ExternalLink, Loader2 } from "lucide-react";
import type { DeployRun } from "@multica/core/api/schemas";
import { deployOptions } from "@multica/core/deploy/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { useT, useTimeAgo } from "../i18n";

/**
 * Sidebar footer strip showing the latest staging deploy run.
 *
 * Fed by the host-side collector snapshot relayed at GET /api/deploy (a cron
 * script wrapping `gh run list`). Renders nothing when the server has no
 * snapshot or the snapshot carries no run, so deployments without a collector
 * see no empty box. The PR and issue links are whatever the collector resolved
 * from the run name; either may be absent.
 */
export function StagingDeployCard() {
  const { t } = useT("layout");
  const timeAgo = useTimeAgo();
  const wsPaths = useWorkspacePaths();
  const { data } = useQuery(deployOptions());
  const run = data?.run ?? null;
  if (!run) return null;

  const when = run.updatedAt ?? run.createdAt;
  const { Icon, className, label } = describeRun(run, t);

  return (
    <div className="flex flex-col gap-1 px-2 pb-2 text-caption">
      <div className="flex items-center gap-1.5">
        <a
          href={run.url}
          target="_blank"
          rel="noopener noreferrer"
          title={label}
          aria-label={label}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground hover:underline"
        >
          <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />
          <span className="truncate font-medium">{t(($) => $.sidebar.deploy.title)}</span>
        </a>
        {when && <span className="shrink-0 text-muted-foreground">{timeAgo(when)}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
        {run.ref && <span className="truncate font-mono">{run.ref}</span>}
        {run.ref && run.actor && <span aria-hidden>·</span>}
        {run.actor && <span className="shrink-0 truncate">{run.actor}</span>}
      </div>
      {(data?.issueIdentifier || data?.pr) && (
        <div className="flex min-w-0 items-center gap-2">
          {data?.issueIdentifier && (
            <AppLink
              href={wsPaths.issueDetail(data.issueIdentifier)}
              className="shrink-0 font-medium text-foreground hover:underline"
            >
              {data.issueIdentifier}
            </AppLink>
          )}
          {data?.pr && (
            <a
              href={data.pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title={data.pr.title}
              className="flex min-w-0 items-center gap-0.5 text-muted-foreground hover:underline"
            >
              <span className="truncate">#{data.pr.number}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

type Translate = ReturnType<typeof useT<"layout">>["t"];

// Collapses GitHub's status/conclusion pair into one icon + label. Unknown
// values (a new conclusion GitHub adds later) fall through to the neutral
// icon rather than crashing or guessing at a color.
function describeRun(run: DeployRun, t: Translate) {
  if (run.status === "completed") {
    switch (run.conclusion) {
      case "success":
        return { Icon: CircleCheck, className: "text-success", label: t(($) => $.sidebar.deploy.success) };
      case "failure":
      case "timed_out":
      case "startup_failure":
        return { Icon: CircleX, className: "text-destructive", label: t(($) => $.sidebar.deploy.failed) };
      case "cancelled":
        return { Icon: CircleDashed, className: "text-muted-foreground", label: t(($) => $.sidebar.deploy.cancelled) };
      default:
        return { Icon: CircleDashed, className: "text-muted-foreground", label: run.conclusion ?? run.status };
    }
  }
  switch (run.status) {
    case "in_progress":
    case "queued":
    case "waiting":
    case "pending":
    case "requested":
      return { Icon: Loader2, className: "animate-spin text-warning", label: t(($) => $.sidebar.deploy.running) };
    default:
      return { Icon: CircleDashed, className: "text-muted-foreground", label: run.status };
  }
}
