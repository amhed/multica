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

import { HealthCard } from "./host-health-card";

function renderCard() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <HealthCard wsId="ws-1" />
    </I18nProvider>,
  );
}

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
