// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import type { HostReapRequest } from "@multica/core/types";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const initiateHostReap = vi.hoisted(() => vi.fn());
const getHostReapResult = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    initiateHostReap: (daemonId: string, mode: "dryrun" | "apply") =>
      initiateHostReap(daemonId, mode),
    getHostReapResult: (daemonId: string, requestId: string) =>
      getHostReapResult(daemonId, requestId),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { ReapDialog } from "./reap-dialog";

function request(overrides: Partial<HostReapRequest>): HostReapRequest {
  return {
    id: "r1",
    daemon_id: "daemon-1",
    workspace_id: "ws-1",
    runtime_id: "rt-1",
    mode: "dryrun",
    status: "pending",
    result: null,
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

function renderDialog(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ReapDialog daemonId="daemon-1" onClose={onClose} />
      </I18nProvider>,
    ),
  };
}

beforeEach(() => {
  initiateHostReap.mockReset();
  getHostReapResult.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

afterEach(() => cleanup());

describe("ReapDialog", () => {
  it("fires a dry-run preview on open and renders the process list and count", async () => {
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult.mockResolvedValue(
      request({
        status: "completed",
        result: {
          mode: "dryrun",
          count: 1,
          load_before: "1.0 1.0 1.0",
          load_after: null,
          sigkilled: null,
          processes: [
            { pid: 123, age_seconds: 900, pcpu: "12.5", reason: "orphaned", command: "node worker.js" },
          ],
        },
      }),
    );

    renderDialog();

    await waitFor(() => expect(initiateHostReap).toHaveBeenCalledWith("daemon-1", "dryrun"));
    expect(await screen.findByText("1 process found")).toBeTruthy();
    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.getByText("node worker.js")).toBeTruthy();
  });

  it("confirm fires apply, shows pending, then toasts the result", async () => {
    const user = userEvent.setup();
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult.mockResolvedValueOnce(
      request({
        status: "completed",
        result: {
          mode: "dryrun",
          count: 1,
          load_before: "1.0 1.0 1.0",
          load_after: null,
          sigkilled: null,
          processes: [
            { pid: 123, age_seconds: 900, pcpu: "12.5", reason: "orphaned", command: "node worker.js" },
          ],
        },
      }),
    );

    renderDialog();
    await screen.findByText("1 process found");

    let resolveApply!: (v: HostReapRequest) => void;
    getHostReapResult.mockReturnValueOnce(
      new Promise<HostReapRequest>((resolve) => {
        resolveApply = resolve;
      }),
    );

    await user.click(screen.getByRole("button", { name: "Reap now" }));

    expect(await screen.findByRole("button", { name: "Reaping…" })).toBeTruthy();

    resolveApply(
      request({
        status: "completed",
        mode: "apply",
        result: {
          mode: "apply",
          count: 1,
          load_before: "1.0 1.0 1.0",
          load_after: "0.5 0.6 0.8",
          sigkilled: 1,
          processes: [],
        },
      }),
    );

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Reaped 1 process(es) (1 needed SIGKILL). Load 1.0 1.0 1.0 → 0.5 0.6 0.8.",
      ),
    );
    expect(initiateHostReap).toHaveBeenCalledWith("daemon-1", "apply");
  });

  it("shows the daemon-did-not-respond state on a preview timeout and confirms no kill happened", async () => {
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult.mockResolvedValue(request({ status: "timeout" }));

    renderDialog();

    expect(await screen.findByText("Daemon did not respond")).toBeTruthy();
    expect(
      screen.getByText("The host did not respond in time. No processes were killed."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reap now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(initiateHostReap).toHaveBeenCalledTimes(1);
  });

  it("shows a distinct failed state (not the timeout copy) on a preview failure, surfacing the daemon's error", async () => {
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult.mockResolvedValue(
      request({ status: "failed", error: "reaper binary exited 1" }),
    );

    renderDialog();

    expect(
      await screen.findByText("The daemon reported an error: reaper binary exited 1"),
    ).toBeTruthy();
    expect(screen.queryByText("Daemon did not respond")).toBeNull();
    expect(
      screen.queryByText("The host did not respond in time. No processes were killed."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Reap now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("toasts the daemon's error (not the timeout copy) when apply comes back failed", async () => {
    const user = userEvent.setup();
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult.mockResolvedValueOnce(
      request({
        status: "completed",
        result: {
          mode: "dryrun",
          count: 1,
          load_before: "1.0 1.0 1.0",
          load_after: null,
          sigkilled: null,
          processes: [
            { pid: 123, age_seconds: 900, pcpu: "12.5", reason: "orphaned", command: "node worker.js" },
          ],
        },
      }),
    );

    renderDialog();
    await screen.findByText("1 process found");

    getHostReapResult.mockResolvedValueOnce(
      request({ status: "failed", mode: "apply", error: "reaper binary exited 1" }),
    );

    await user.click(screen.getByRole("button", { name: "Reap now" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Reap failed: reaper binary exited 1"),
    );
    expect(mockToastError).not.toHaveBeenCalledWith(
      "Reap failed. No confirmation was received from the host.",
    );
  });

  it("reaches a closeable state (not stuck on loading) when the preview request itself throws", async () => {
    initiateHostReap.mockRejectedValue(new Error("503"));

    renderDialog();

    expect(await screen.findByText("Daemon did not respond")).toBeTruthy();
    expect(screen.queryByText("Scanning host for leaked processes…")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("toasts an error and closes (never stays stuck on applying) when the apply request itself throws", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    initiateHostReap.mockResolvedValue({ request_id: "r1" });
    getHostReapResult.mockResolvedValueOnce(
      request({
        status: "completed",
        result: {
          mode: "dryrun",
          count: 1,
          load_before: "1.0 1.0 1.0",
          load_after: null,
          sigkilled: null,
          processes: [
            { pid: 123, age_seconds: 900, pcpu: "12.5", reason: "orphaned", command: "node worker.js" },
          ],
        },
      }),
    );

    renderDialog(onClose);
    await screen.findByText("1 process found");

    initiateHostReap.mockRejectedValueOnce(new Error("503"));

    await user.click(screen.getByRole("button", { name: "Reap now" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Reap failed. The daemon reported an error running the reaper.",
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
