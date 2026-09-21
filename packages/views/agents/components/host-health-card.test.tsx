// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import type { HostHealth } from "@multica/core/types";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const queryState = vi.hoisted(() => ({
  current: { data: undefined as unknown, isLoading: false },
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: () => queryState.current,
}));
vi.mock("@multica/core/api", () => ({ api: {} }));

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
});
