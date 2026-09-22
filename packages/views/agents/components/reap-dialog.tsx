"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { resolveHostReap } from "@multica/core/agents";
import type { HostReapRequest } from "@multica/core/types";
import { useT } from "../../i18n";

type Phase = "loading" | "preview" | "applying" | "timeout" | "failed";

/**
 * Preview -> confirm dialog for the admin-triggered leaked-process reaper.
 * Opens already running a dry-run preview; Confirm re-selects fresh (the
 * process list can shift between preview and apply) and reports the applied
 * result as a toast rather than inline, since the dialog closes on success.
 */
export function ReapDialog({
  daemonId,
  onClose,
}: {
  daemonId: string;
  onClose: () => void;
}) {
  const { t } = useT("agents");
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<HostReapRequest | null>(null);

  const runPreview = () => {
    setPhase("loading");
    setPreview(null);
    resolveHostReap(daemonId, "dryrun").then((request) => {
      setPreview(request);
      // "failed" means the daemon responded but the scan itself errored;
      // "timeout" (and any other non-terminal status) means the client gave
      // up waiting — distinct enough to need distinct copy (see
      // reap.failed_* vs reap.offline_*), since a failed run is worth
      // retrying differently than a request that never got an answer.
      if (request.status === "completed") setPhase("preview");
      else if (request.status === "failed") setPhase("failed");
      else setPhase("timeout");
    });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per mount, daemonId is stable for the dialog's lifetime
  useEffect(() => runPreview(), [daemonId]);

  const handleConfirm = async () => {
    setPhase("applying");
    const applied = await resolveHostReap(daemonId, "apply");
    if (applied.status === "completed" && applied.result) {
      toast.success(
        t(($) => $.active_board.host.reap.success_toast, {
          count: applied.result.count,
          sigkilled: applied.result.sigkilled ?? 0,
          loadBefore: applied.result.load_before,
          loadAfter: applied.result.load_after ?? applied.result.load_before,
        }),
      );
      onClose();
      return;
    }
    if (applied.status === "failed") {
      toast.error(
        applied.error
          ? t(($) => $.active_board.host.reap.apply_error_toast, { error: applied.error })
          : t(($) => $.active_board.host.reap.apply_error_toast_generic),
      );
      onClose();
      return;
    }
    toast.error(t(($) => $.active_board.host.reap.apply_timeout_toast));
    onClose();
  };

  const processes = preview?.result?.processes ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && phase !== "applying") onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.active_board.host.reap.dialog_title)}</DialogTitle>
          <DialogDescription>
            {phase === "timeout"
              ? t(($) => $.active_board.host.reap.offline_description)
              : phase === "failed"
                ? t(($) => $.active_board.host.reap.failed_description)
                : t(($) => $.active_board.host.reap.reselect_note)}
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" && (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.active_board.host.reap.preview_pending)}
          </p>
        )}

        {phase === "timeout" && (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.active_board.host.reap.offline_title)}
          </p>
        )}

        {phase === "failed" && (
          <p className="text-caption text-muted-foreground">
            {preview?.error
              ? t(($) => $.active_board.host.reap.failed_title_detail, { error: preview.error })
              : t(($) => $.active_board.host.reap.failed_title)}
          </p>
        )}

        {(phase === "preview" || phase === "applying") && (
          <>
            <p className="text-caption text-muted-foreground">
              {t(($) => $.active_board.host.reap.count, { count: processes.length })}
            </p>
            {processes.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(($) => $.active_board.host.reap.column_pid)}</TableHead>
                    <TableHead>{t(($) => $.active_board.host.reap.column_age)}</TableHead>
                    <TableHead>{t(($) => $.active_board.host.reap.column_cpu)}</TableHead>
                    <TableHead>{t(($) => $.active_board.host.reap.column_reason)}</TableHead>
                    <TableHead>{t(($) => $.active_board.host.reap.column_command)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processes.map((process) => (
                    <TableRow key={process.pid}>
                      <TableCell className="tabular-nums">{process.pid}</TableCell>
                      <TableCell className="tabular-nums">
                        {t(($) => $.active_board.host.reap.age_value, {
                          seconds: process.age_seconds,
                        })}
                      </TableCell>
                      <TableCell className="tabular-nums">{process.pcpu}</TableCell>
                      <TableCell>{process.reason}</TableCell>
                      <TableCell
                        className="max-w-80 truncate font-mono text-micro"
                        title={process.command}
                      >
                        {process.command}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}

        <DialogFooter>
          {phase === "timeout" || phase === "failed" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t(($) => $.active_board.host.reap.cancel)}
              </Button>
              <Button onClick={runPreview}>{t(($) => $.active_board.host.reap.retry)}</Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={onClose}
                disabled={phase === "applying"}
              >
                {t(($) => $.active_board.host.reap.cancel)}
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirm}
                disabled={phase !== "preview"}
                aria-busy={phase === "applying"}
              >
                {phase === "applying"
                  ? t(($) => $.active_board.host.reap.confirm_pending)
                  : t(($) => $.active_board.host.reap.confirm_button)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
