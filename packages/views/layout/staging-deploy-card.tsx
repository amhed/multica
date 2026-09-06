"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleX, ExternalLink, Loader2 } from "lucide-react";
import type { DeployEntry, DeployRun } from "@multica/core/api/schemas";
import { deployOptions } from "@multica/core/deploy/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { useT, useTimeAgo } from "../i18n";

/**
 * Sidebar footer strip showing the latest staging deploy of each tracked repo.
 *
 * Fed by the host-side collector snapshot relayed at GET /api/deploy (a cron
 * script wrapping `gh api`). Renders nothing when the server has no snapshot
 * or the snapshot lists no deploys, so deployments without a collector see no
 * empty box. The PR and issue links are whatever the collector resolved from
 * the run's head commit; either may be absent.
 */
export function StagingDeployCard() {
  const { t } = useT("layout");
  const timeAgo = useTimeAgo();
  const wsPaths = useWorkspacePaths();
  const { data } = useQuery(deployOptions());
  const deploys = data?.deploys ?? [];
  if (deploys.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-2 pb-2 text-caption">
      {deploys.map((deploy) => (
        <DeployRow
          key={deploy.repo}
          deploy={deploy}
          issueHref={deploy.issueIdentifier ? wsPaths.issueDetail(deploy.issueIdentifier) : null}
          when={(iso) => timeAgo(iso)}
          describe={(run) => describeRun(run, t)}
        />
      ))}
    </div>
  );
}

function DeployRow({
  deploy,
  issueHref,
  when,
  describe,
}: {
  deploy: DeployEntry;
  issueHref: string | null;
  when: (iso: string) => string;
  describe: (run: DeployRun) => { Icon: typeof CircleCheck; className: string; label: string };
}) {
  const { run, pr, issueIdentifier } = deploy;
  const updated = run.updatedAt ?? run.createdAt;
  const { Icon, className, label } = describe(run);
  // "owner/repo" reads as noise in a narrow sidebar; the repo name alone is
  // what distinguishes the rows.
  const shortRepo = deploy.repo.split("/").pop() ?? deploy.repo;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <a
          href={run.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${deploy.workflow}: ${label}`}
          aria-label={`${shortRepo}: ${label}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground hover:underline"
        >
          <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />
          <span className="truncate font-medium">{shortRepo}</span>
        </a>
        {updated && <span className="shrink-0 text-muted-foreground">{when(updated)}</span>}
      </div>
      {(issueIdentifier || pr) && (
        <div className="flex min-w-0 items-center gap-2 pl-5">
          {issueIdentifier && issueHref && (
            <AppLink href={issueHref} className="shrink-0 font-medium text-foreground hover:underline">
              {issueIdentifier}
            </AppLink>
          )}
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title={pr.title}
              className="flex min-w-0 items-center gap-0.5 text-muted-foreground hover:underline"
            >
              <span className="truncate">#{pr.number}</span>
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
