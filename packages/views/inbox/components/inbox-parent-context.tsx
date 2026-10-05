"use client";

import type { InboxIssueAncestor } from "@multica/core/types";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { GitBranch } from "lucide-react";
import { StatusIcon } from "../../issues/components";
import { useStatusLabel } from "../../issues/utils/status-label";
import { useT } from "../../i18n";

export function InboxParentContext({
  issue,
  workspaceId,
  isSelected,
  onClick,
}: {
  issue: InboxIssueAncestor;
  workspaceId: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { t } = useT("inbox");
  const { categoryOf, colorOf } = useIssueStatuses(workspaceId);
  const statusLabel = useStatusLabel(workspaceId);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full min-w-0 cursor-default select-none items-center gap-2 rounded-md px-2 py-2.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring ${
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      <GitBranch aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span title={issue.title} className="min-w-0 flex-1 truncate text-body font-medium">{issue.title}</span>
          <span title={statusLabel(issue.status)}><StatusIcon status={issue.status} category={categoryOf(issue.status)} color={colorOf(issue.status)} className="size-3.5" /></span>
        </div>
        <p className="text-caption text-muted-foreground">{t(($) => $.hierarchy.parent_context)}</p>
      </div>
    </button>
  );
}
