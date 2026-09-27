import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureShortcutPlatform } from "@multica/core/shortcuts";
import { GlobalShortcuts } from "./global-shortcuts";

// Mod+Shift+O lands on a fresh compose bound to the agent of the user's most
// recently active chat, via the chat page's `?agent=` deep link.
const h = vi.hoisted(() => ({
  navigation: { pathname: "/acme/issues", push: vi.fn() },
  listChatSessions: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: { listChatSessions: h.listChatSessions, listAgents: h.listAgents },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/chat", () => ({
  useChatStore: { getState: () => ({ floatingChatEnabled: false }) },
}));
vi.mock("@multica/core/issues/stores", () => ({
  openCreateIssueWithPreference: vi.fn(),
}));
vi.mock("@multica/core/modals", () => ({
  useModalStore: { getState: () => ({ modal: null }) },
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    inbox: () => "/acme/inbox",
    chat: () => "/acme/chat",
    chatWithAgent: (id: string) => `/acme/chat?agent=${id}`,
    myIssues: () => "/acme/my-issues",
    issues: () => "/acme/issues",
    projects: () => "/acme/projects",
    autopilots: () => "/acme/autopilots",
    agents: () => "/acme/agents",
    squads: () => "/acme/squads",
    usage: () => "/acme/usage",
    runtimes: () => "/acme/runtimes",
    skills: () => "/acme/skills",
    settings: () => "/acme/settings",
  }),
}));
vi.mock("@multica/ui/components/ui/sidebar", () => ({
  useSidebar: () => ({ toggleSidebar: vi.fn() }),
}));
vi.mock("../navigation", () => ({ useNavigation: () => h.navigation }));
vi.mock("../search/search-store", () => ({
  useSearchStore: { getState: () => ({ toggle: vi.fn() }) },
}));

const session = (id: string, agent_id: string, updated_at: string) => ({
  id,
  workspace_id: "ws-1",
  agent_id,
  creator_id: "u",
  title: id,
  status: "active",
  has_unread: false,
  created_at: updated_at,
  updated_at,
});

function renderShortcuts() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalShortcuts />
    </QueryClientProvider>,
  );
}

/** Cmd+Shift+O on macOS; Shift makes the browser report an uppercase key. */
function pressNewChat(target: EventTarget = document): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "O",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  configureShortcutPlatform("macos");
  h.navigation.pathname = "/acme/issues";
  h.listChatSessions.mockResolvedValue([
    session("older", "agent-old", "2026-01-01T00:00:00Z"),
    session("newer", "agent-new", "2026-06-01T00:00:00Z"),
  ]);
  h.listAgents.mockResolvedValue([
    { id: "agent-old", archived_at: null },
    { id: "agent-new", archived_at: null },
  ]);
});

afterEach(() => {
  configureShortcutPlatform(null);
  vi.clearAllMocks();
});

describe("new chat with last agent shortcut", () => {
  it("opens a new chat with the agent of the most recent chat", async () => {
    renderShortcuts();

    expect(pressNewChat()).toBe(true);
    await waitFor(() =>
      expect(h.navigation.push).toHaveBeenCalledWith("/acme/chat?agent=agent-new"),
    );
  });

  it("fires while the caret is inside a text field", async () => {
    renderShortcuts();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    expect(pressNewChat(input)).toBe(true);
    await waitFor(() =>
      expect(h.navigation.push).toHaveBeenCalledWith("/acme/chat?agent=agent-new"),
    );

    input.remove();
  });

  it("falls back to the chat page when there is no previous chat", async () => {
    h.listChatSessions.mockResolvedValue([]);
    renderShortcuts();

    pressNewChat();
    await waitFor(() => expect(h.navigation.push).toHaveBeenCalledWith("/acme/chat"));
  });

  it("falls back to the chat page when chat history fails to load", async () => {
    h.listChatSessions.mockRejectedValue(new Error("offline"));
    renderShortcuts();

    pressNewChat();
    await waitFor(() => expect(h.navigation.push).toHaveBeenCalledWith("/acme/chat"));
  });

  it("does not fire on Mod+O without Shift", () => {
    renderShortcuts();

    const event = new KeyboardEvent("keydown", {
      key: "o",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(h.listChatSessions).not.toHaveBeenCalled();
  });
});
