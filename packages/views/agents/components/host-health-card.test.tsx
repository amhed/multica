// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import type { HostHealth } from "@multica/core/types";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const queryState = vi.hoisted(() => ({
  current: { data: undefined as unknown, isLoading: false },
}));
const membersState = vi.hoisted(() => ({
  current: { data: [] as { user_id: string; role: string }[], isFetched: true },
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey.includes("members") ? membersState.current : queryState.current,
}));
vi.mock("@multica/core/api", () => ({ api: {} }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: (wsId: string) => ({ queryKey: ["workspaces", wsId, "members"] }),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { HealthCard } from "./host-health-card";

function renderCard() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <HealthCard wsId="ws-1" />
    </I18nProvider>,
  );
}

// A daemon that predates the saturation signals.
const NOT_MEASURED = {
  cpu_busy_pct: null,
  swap_in_kbps: null,
  swap_out_kbps: null,
  procs_blocked: null,
  cgroup_mem_current_kb: 0,
  cgroup_mem_limit_kb: 0,
  tasks: [],
  stale: null,
};

const redHost: HostHealth = {
  daemon_id: "d1",
  device_name: "tinydevs-droplet",
  ncpu: 8,
  load1: 65,
  load5: 64,
  load15: 65,
  mem_total_kb: 16_000_000,
  mem_available_kb: 1_000_000,
  swap_total_kb: 4_000_000,
  swap_free_kb: 0,
  ...NOT_MEASURED,
};

const greenHost: HostHealth = {
  daemon_id: "d2",
  device_name: "healthy-box",
  ncpu: 8,
  load1: 1,
  load5: 1,
  load15: 1,
  mem_total_kb: 16_000_000,
  mem_available_kb: 8_000_000,
  swap_total_kb: 4_000_000,
  swap_free_kb: 4_000_000,
  ...NOT_MEASURED,
};

// moni-hermes five minutes after a restart: load15 still 16 on 4 cores, but
// the CPU is idle and nothing is paging.
const measuredHost: HostHealth = {
  daemon_id: "d3",
  device_name: "moni-hermes",
  ncpu: 4,
  load1: 0.26,
  load5: 7.19,
  load15: 16.22,
  mem_total_kb: 24_000_000,
  mem_available_kb: 15_600_000,
  swap_total_kb: 11_000_000,
  swap_free_kb: 7_400_000,
  cpu_busy_pct: 4,
  swap_in_kbps: 0,
  swap_out_kbps: 102.4,
  procs_blocked: 0,
  cgroup_mem_current_kb: 6_291_456,
  cgroup_mem_limit_kb: 15_728_640,
  tasks: [],
  stale: null,
};

// The PAI-322 thrash, as the per-task rows would have shown it.
const thrashingHost: HostHealth = {
  ...measuredHost,
  cpu_busy_pct: 100,
  swap_in_kbps: 40_000,
  cgroup_mem_current_kb: 15_600_000,
  tasks: [
    {
      task_id: "t1",
      workspace_id: "ws-1",
      issue_id: "issue-322",
      issue_identifier: "PAI-322",
      agent_name: "Codex Senior Dev",
      procs: 9,
      rss_kb: 15_204_352,
      cpu_pct: 71.6,
      top_cmd: "tsgo --noEmit",
      top_cmd_age_s: 16_260,
    },
  ],
  stale: { procs: 3, rss_kb: 1_048_576, cpu_pct: 0, top_cmd: "eslint", top_cmd_age_s: 7_200 },
};

beforeEach(() => {
  membersState.current = { data: [], isFetched: true };
});

afterEach(() => cleanup());

describe("HealthCard", () => {
  it("renders the muted unavailable state when no host reported", () => {
    queryState.current = { data: { hosts: [] }, isLoading: false };
    renderCard();
    expect(screen.getByText("Host metrics unavailable")).toBeTruthy();
  });

  it("renders a populated host with device name, status and metrics", () => {
    queryState.current = { data: { hosts: [redHost] }, isLoading: false };
    renderCard();
    expect(screen.getByText("tinydevs-droplet")).toBeTruthy();
    expect(screen.getByText("Saturated")).toBeTruthy(); // red status label
    expect(screen.getByText("65.00 / 8")).toBeTruthy(); // load15 / ncpu
    expect(screen.getByText("94%")).toBeTruthy(); // memory used (1 - 1/16)
    expect(screen.getByText("100%")).toBeTruthy(); // swap used
  });

  it("shows current signals, not the lagging load15, for a daemon that reports rates", () => {
    queryState.current = { data: { hosts: [measuredHost] }, isLoading: false };
    renderCard();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("4%")).toBeTruthy(); // CPU busy
    expect(screen.getByText("0.26 / 4")).toBeTruthy(); // load1 / ncpu
    expect(screen.queryByText("16.22 / 4")).toBeNull();
    expect(screen.getByText("0 KB/s / 102 KB/s")).toBeTruthy(); // swap in / out
    expect(screen.getByText("6.0 GB / 15.0 GB")).toBeTruthy(); // agent memory / cgroup limit
  });

  it("shows agent memory without a limit when none is visible", () => {
    queryState.current = {
      data: { hosts: [{ ...measuredHost, cgroup_mem_limit_kb: 0 }] },
      isLoading: false,
    };
    renderCard();
    expect(screen.getByText("6.0 GB")).toBeTruthy();
  });

  it("lists each running task with its issue link, footprint and top command", () => {
    queryState.current = { data: { hosts: [thrashingHost] }, isLoading: false };
    renderCard();
    expect(screen.getByText("Saturated")).toBeTruthy();
    const link = screen.getByRole("link", { name: "PAI-322" });
    expect(link.getAttribute("href")).toBe("/acme/issues/issue-322");
    expect(screen.getByText("Codex Senior Dev")).toBeTruthy();
    expect(screen.getByText("14.5 GB · 72% CPU")).toBeTruthy();
    expect(screen.getByText("tsgo --noEmit · 4h 31m")).toBeTruthy();
  });

  it("shows orphaned processes left by finished tasks", () => {
    queryState.current = { data: { hosts: [thrashingHost] }, isLoading: false };
    renderCard();
    expect(screen.getByText("3 orphaned processes (30+ min)")).toBeTruthy();
    expect(screen.getByText("1.0 GB · 0% CPU")).toBeTruthy();
    expect(screen.getByText("eslint · 2h 0m")).toBeTruthy();
  });

  it("renders no task list when nothing is running", () => {
    queryState.current = { data: { hosts: [measuredHost] }, isLoading: false };
    renderCard();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows a skeleton while loading", () => {
    queryState.current = { data: undefined, isLoading: true };
    const { container } = renderCard();
    expect(container.querySelector('[data-slot="skeleton"], .animate-pulse')).toBeTruthy();
  });

  it("shows the reap action on an amber/red row for an admin", () => {
    queryState.current = { data: { hosts: [redHost] }, isLoading: false };
    membersState.current = { data: [{ user_id: "user-1", role: "admin" }], isFetched: true };
    renderCard();
    expect(screen.getByRole("button", { name: "Reap leaked processes" })).toBeTruthy();
  });

  it("hides the reap action on an amber/red row for a plain member", () => {
    queryState.current = { data: { hosts: [redHost] }, isLoading: false };
    membersState.current = { data: [{ user_id: "user-1", role: "member" }], isFetched: true };
    renderCard();
    expect(screen.queryByRole("button", { name: "Reap leaked processes" })).toBeNull();
  });

  it("hides the reap action when the host has no daemon id to target", () => {
    queryState.current = { data: { hosts: [{ ...redHost, daemon_id: "" }] }, isLoading: false };
    membersState.current = { data: [{ user_id: "user-1", role: "admin" }], isFetched: true };
    renderCard();
    expect(screen.queryByRole("button", { name: "Reap leaked processes" })).toBeNull();
  });

  it("hides the reap action on a green row even for an admin", () => {
    queryState.current = { data: { hosts: [greenHost] }, isLoading: false };
    membersState.current = { data: [{ user_id: "user-1", role: "owner" }], isFetched: true };
    renderCard();
    expect(screen.queryByRole("button", { name: "Reap leaked processes" })).toBeNull();
  });
});
