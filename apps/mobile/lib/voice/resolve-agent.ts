/**
 * Pick the Voice tab's default agent. Last-used wins when that agent is
 * still in the assignable list; otherwise fall through to the first
 * available agent (same order Chat uses).
 */
export function resolveVoiceAgent<T extends { id: string }>(
  storedId: string | null,
  available: T[],
): T | null {
  if (available.length === 0) return null;
  if (storedId) {
    const match = available.find((agent) => agent.id === storedId);
    if (match) return match;
  }
  return available[0] ?? null;
}
