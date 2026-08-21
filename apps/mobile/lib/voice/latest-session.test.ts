import { describe, expect, it } from "vitest";
import type { ChatSession } from "@multica/core/types";
import { latestSessionForAgent, resolveBoundSessionId } from "./latest-session";

function session(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    creator_id: "user-1",
    title: "Chat",
    status: "active",
    has_unread: false,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("latestSessionForAgent", () => {
  it("picks the most recently updated active session for the agent", () => {
    const older = session({
      id: "old",
      updated_at: "2026-08-01T10:00:00Z",
    });
    const newer = session({
      id: "new",
      updated_at: "2026-08-01T12:00:00Z",
    });
    const otherAgent = session({
      id: "other",
      agent_id: "agent-2",
      updated_at: "2026-08-01T13:00:00Z",
    });

    expect(latestSessionForAgent([otherAgent, older, newer], "agent-1")?.id).toBe(
      "new",
    );
  });

  it("prefers last_message.created_at over session.updated_at", () => {
    const staleTitleUpdate = session({
      id: "stale",
      updated_at: "2026-08-01T14:00:00Z",
      last_message: {
        content: "hi",
        role: "user",
        created_at: "2026-08-01T10:00:00Z",
      },
    });
    const recentTurn = session({
      id: "recent",
      updated_at: "2026-08-01T11:00:00Z",
      last_message: {
        content: "later",
        role: "assistant",
        created_at: "2026-08-01T13:00:00Z",
      },
    });

    expect(
      latestSessionForAgent([staleTitleUpdate, recentTurn], "agent-1")?.id,
    ).toBe("recent");
  });

  it("skips archived sessions", () => {
    const archived = session({
      id: "archived",
      status: "archived",
      updated_at: "2026-08-01T20:00:00Z",
    });
    const active = session({
      id: "active",
      updated_at: "2026-08-01T10:00:00Z",
    });

    expect(latestSessionForAgent([archived, active], "agent-1")?.id).toBe(
      "active",
    );
  });

  it("returns null when the agent has no active session", () => {
    expect(latestSessionForAgent([session({ agent_id: "other" })], "agent-1")).toBeNull();
    expect(latestSessionForAgent([], "agent-1")).toBeNull();
  });
});

describe("resolveBoundSessionId", () => {
  const older = session({
    id: "old",
    updated_at: "2026-08-01T10:00:00Z",
  });
  const newer = session({
    id: "new",
    updated_at: "2026-08-01T12:00:00Z",
  });

  it("binds the latest session when not starting fresh", () => {
    expect(
      resolveBoundSessionId({
        agentId: "agent-1",
        sessions: [older, newer],
        currentSessionId: older.id,
        startFresh: false,
      }),
    ).toBe("new");
  });

  it("stays blank after + even when a latest session exists", () => {
    expect(
      resolveBoundSessionId({
        agentId: "agent-1",
        sessions: [older, newer],
        currentSessionId: null,
        startFresh: true,
      }),
    ).toBeNull();
  });

  it("keeps a just-created session that is not in the list yet", () => {
    expect(
      resolveBoundSessionId({
        agentId: "agent-1",
        sessions: [older, newer],
        currentSessionId: "brand-new",
        startFresh: true,
      }),
    ).toBe("brand-new");
  });

  it("does not snap a fresh session back to the older latest", () => {
    const created = session({
      id: "brand-new",
      updated_at: "2026-08-01T09:00:00Z",
    });
    expect(
      resolveBoundSessionId({
        agentId: "agent-1",
        sessions: [older, newer, created],
        currentSessionId: created.id,
        startFresh: true,
      }),
    ).toBe("brand-new");
  });

  it("drops a fresh session that belongs to another agent", () => {
    expect(
      resolveBoundSessionId({
        agentId: "agent-1",
        sessions: [session({ id: "other", agent_id: "agent-2" })],
        currentSessionId: "other",
        startFresh: true,
      }),
    ).toBeNull();
  });

  it("returns null when no agent is selected", () => {
    expect(
      resolveBoundSessionId({
        agentId: null,
        sessions: [newer],
        currentSessionId: newer.id,
        startFresh: false,
      }),
    ).toBeNull();
  });
});
