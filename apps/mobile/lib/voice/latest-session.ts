import type { ChatSession } from "@multica/core/types";

function sessionRecency(session: ChatSession): string {
  return session.last_message?.created_at ?? session.updated_at;
}

/**
 * Most recent active chat session for an agent. Mirrors the Chat tab's
 * "continue this conversation" mental model so a voice turn lands on the
 * same thread the user would see under Chat / web.
 *
 * List order from `GET /api/chat/sessions` is pinned-first, so we do not
 * take the first matching row — we compare last-message / updated_at.
 */
export function latestSessionForAgent(
  sessions: ChatSession[],
  agentId: string,
): ChatSession | null {
  let latest: ChatSession | null = null;
  for (const session of sessions) {
    if (session.agent_id !== agentId) continue;
    if (session.status !== "active") continue;
    if (!latest || sessionRecency(session) > sessionRecency(latest)) {
      latest = session;
    }
  }
  return latest;
}
