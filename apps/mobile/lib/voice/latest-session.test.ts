import { describe, expect, it } from "vitest";
import type { ChatSession } from "@multica/core/types";
import { latestSessionForAgent } from "./latest-session";

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
