// @vitest-environment jsdom

// Selection/sort/summary rules are covered in active-board.test.ts; this suite
// keeps the wiring: one card per board task, waiting-first order, the ?task=
// param opening/closing the agent window, and the empty state.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
vi.mock("@multica/core/api", () => ({
  api: { getBaseUrl: () => "http://127.0.0.1:8080" },
}));
const navState = vi.hoisted(() => ({ search: new URLSearchParams(), replace: vi.fn() }));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useNavigation: () => ({
    pathname: "/acme/active",
    searchParams: navState.search,
    replace: navState.replace,
    push: vi.fn(),
    back: vi.fn(),
    hash: "",
  }),
}));
vi.mock("./agent-window", () => ({
  AgentWindow: ({ task }: { task: { id: string } | null }) => (task ? <div role="dialog">window:{task.id}</div> : null),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("../../common/task-transcript/transcript-button", () => ({
  TranscriptButton: () => <button>transcript</button>,
}));

const buildStepsSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../common/task-transcript/build-steps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../common/task-transcript/build-steps")>();
  return {
    ...actual,
    buildSteps: (...args: Parameters<typeof actual.buildSteps>) => {
      buildStepsSpy.calls += 1;
      return actual.buildSteps(...args);
    },
  };
});

const mockAgents = vi.hoisted(() => ({ current: [] as unknown[] }));
const mockSnapshot = vi.hoisted(() => ({ current: [] as unknown[] }));
const mockIssues = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const mockMessages = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (o: unknown) => o,
  useQuery: (opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const [root, , marker, id] = opts.queryKey;
    if (root === "workspaces" && marker === "agents") return { data: mockAgents.current, isLoading: false };
    if (root === "workspaces" && marker === "agent-task-snapshot") return { data: mockSnapshot.current, isLoading: false };
    if (root === "issues" && marker === "detail") {
      return { data: opts.enabled ? mockIssues.current[id as string] : undefined, isLoading: false };
    }
    if (root === "task-messages") return { data: opts.enabled ? mockMessages.current : [], isLoading: false };
    return { data: undefined, isLoading: false };
  },
  // Mirrors real `useQueries({ combine })`: when the combined value is deeply
  // unchanged from the previous call, the previous reference is returned so a
  // caller's `useMemo` keyed on it does not re-run. This is what lets the
  // "does not recompute" test below actually exercise the fix instead of
  // trivially passing.
  useQueries: (() => {
    let lastCombined: unknown;
    return ({
      queries,
      combine,
    }: {
      queries: { queryKey: readonly unknown[]; enabled?: boolean }[];
      combine?: (results: { data: unknown[]; isLoading: boolean }[]) => unknown;
    }) => {
      const results = queries.map((q) => ({ data: q.enabled === false ? [] : mockMessages.current, isLoading: false }));
      if (!combine) return results;
      const next = combine(results);
      if (JSON.stringify(next) === JSON.stringify(lastCombined)) return lastCombined;
      lastCombined = next;
      return next;
    };
  })(),
}));

import { ActiveBoardPage } from "./active-board-page";

function renderPage() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ActiveBoardPage />
    </I18nProvider>,
  );
}

const running = {
  id: "11111111-1111-4111-8111-111111111111", agent_id: "a1", runtime_id: "r", issue_id: "i1", status: "running", priority: 0,
  dispatched_at: null, started_at: "2026-09-03T10:00:00Z", completed_at: null, result: null, error: null,
  created_at: "2026-09-03T09:59:00Z", pstack_summary: "Adds a --property flag to issue list.",
};
const finished = {
  ...running, id: "22222222-2222-4222-8222-222222222222", agent_id: "a2", issue_id: "i2", status: "completed",
  completed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), pstack_summary: null,
  handoff_note: "Decide the membership rule",
};

describe("ActiveBoardPage", () => {
  beforeEach(() => {
    mockAgents.current = [{ id: "a1", name: "Codex" }, { id: "a2", name: "Claude" }];
    mockIssues.current = { i1: { id: "i1", identifier: "MUL-1", title: "Flag" }, i2: { id: "i2", identifier: "MUL-2", title: "Auth" } };
    mockMessages.current = [{ seq: 1, type: "text", content: "Every run, or only at creation?" }];
    mockSnapshot.current = [running, finished];
    navState.search = new URLSearchParams();
    navState.replace.mockReset();
    buildStepsSpy.calls = 0;
  });
  afterEach(cleanup);

  it("renders one card per task with the generated headline and a waiting card first", () => {
    renderPage();
    // Each card's headline button carries its own accessible name (the
    // headline text), not the agent name, so the waiting-first order is
    // asserted on which headline comes first rather than on agent name.
    const headlines = screen.getAllByRole("button", {
      name: /Adds a --property flag to issue list\.|Decide the membership rule/,
    });
    expect(headlines[0]).toHaveAccessibleName("Decide the membership rule");
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Adds a --property flag to issue list.")).toBeTruthy();
  });

  it("opens the window through the task search param", () => {
    renderPage();
    fireEvent.click(screen.getByText("Adds a --property flag to issue list."));
    expect(navState.replace).toHaveBeenCalledWith("/acme/active?task=11111111-1111-4111-8111-111111111111");
  });

  it("shows the window when the param is present and clears an unknown one", () => {
    navState.search = new URLSearchParams("task=11111111-1111-4111-8111-111111111111");
    renderPage();
    expect(screen.getByRole("dialog").textContent).toBe("window:11111111-1111-4111-8111-111111111111");
    cleanup();
    navState.search = new URLSearchParams("task=missing");
    renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navState.replace).toHaveBeenCalledWith("/acme/active");
  });

  it("shows the empty state with no tasks", () => {
    mockSnapshot.current = [];
    renderPage();
    expect(screen.getByText("No agents are working right now.")).toBeTruthy();
  });

  it("does not recompute transcript steps on a rerender with unchanged messages", () => {
    const { rerender } = renderPage();
    const callsAfterFirstRender = buildStepsSpy.calls;
    expect(callsAfterFirstRender).toBeGreaterThan(0);
    rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ActiveBoardPage />
      </I18nProvider>,
    );
    // A rerender with the same snapshot and messages must not push the
    // useQueries `combine` result to a new reference, so the useMemo keyed on
    // it should not call buildSteps again.
    expect(buildStepsSpy.calls).toBe(callsAfterFirstRender);
  });
});
