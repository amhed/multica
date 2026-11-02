"use client";

import { useMemo } from "react";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Issue } from "@multica/core/types";
import { StatusIcon } from "../../issues/components/status-icon";
import { useIssueStatusOptions, type StatusOption } from "../../issues/utils/status-options";
import { useT } from "../../i18n";
import { useIssueStatusWriter } from "../issue-target";
import type { PaletteCommand, PaletteIcon } from "../types";

// Extra words that find a built-in status, so "close" or "wip" reaches it
// without opening the status submenu.
const STATUS_SYNONYMS: Record<string, string[]> = {
  todo: ["reopen"],
  in_progress: ["progress", "start", "wip", "doing"],
  in_review: ["review", "reviewing"],
  done: ["complete", "finish", "close", "resolve"],
  blocked: ["block", "stuck"],
  cancelled: ["cancel", "canceled", "wontfix", "abandon"],
};

// The row's icon class tints icons muted, which would wash out the status
// color, so the icon keeps the status picker's sizing instead.
function statusIconOf(option: StatusOption): PaletteIcon {
  function Icon() {
    return (
      <StatusIcon
        status={option.key}
        category={option.category}
        color={option.color}
        icon={option.icon}
        className="size-4 shrink-0"
      />
    );
  }
  return Icon;
}

/**
 * One-step "Mark as <status>" commands for the issue on screen, one per status
 * its workflow offers other than the current one. They are not primary, so
 * they stay out of the empty state and surface only when typed.
 */
export function useIssueStatusCommands(issue: Issue | null): PaletteCommand[] {
  const { t } = useT("search");
  const wsId = useWorkspaceId();
  const { options, workflow } = useIssueStatusOptions(wsId, issue?.project_id, issue?.status);
  const target = useMemo(() => (issue ? { kind: "single" as const, issue } : null), [issue]);
  const setStatus = useIssueStatusWriter(target, workflow);
  const icons = useMemo(
    () => new Map(options.map((option) => [option.key, statusIconOf(option)])),
    [options],
  );

  return useMemo(() => {
    if (!issue) return [];
    return options
      .filter((option) => option.key !== issue.status)
      .map((option) => ({
        id: `issue-mark-status:${option.key}`,
        label: t(($) => $.issue.mark_as, { status: option.label }),
        icon: icons.get(option.key)!,
        keywords: [
          "mark",
          "status",
          option.key.replace(/_/g, " "),
          ...(STATUS_SYNONYMS[option.key] ?? []),
        ],
        run: () => setStatus(option.key),
      }));
  }, [icons, issue, options, setStatus, t]);
}
