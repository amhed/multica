"use client";

import type { InboxIssueAncestor } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { GitBranch } from "lucide-react";
import { AppLink } from "../../navigation";
import { StatusIcon } from "../../issues/components";
import { useStatusLabel } from "../../issues/utils/status-label";
import { useT } from "../../i18n";

export function InboxParentContext({ issue, workspaceId }: { issue: InboxIssueAncestor; workspaceId: string }) {
  const paths = useWorkspacePaths();
  const { t } = useT("inbox");
  const { categoryOf, colorOf } = useIssueStatuses(workspaceId);
  const statusLabel = useStatusLabel(workspaceId);
  return (
    <AppLink href={paths.issueDetail(issue.id)} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2.5 hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring outline-none">
      <GitBranch aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span title={issue.title} className="min-w-0 flex-1 truncate text-body font-medium">{issue.title}</span>
          <span title={statusLabel(issue.status)}><StatusIcon status={issue.status} category={categoryOf(issue.status)} color={colorOf(issue.status)} className="size-3.5" /></span>
        </div>
        <p className="text-caption text-muted-foreground">{t(($) => $.hierarchy.parent_context)}</p>
      </div>
    </AppLink>
  );
}
