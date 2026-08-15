/**
 * Last-used Voice agent, persisted per workspace in SecureStore.
 * Client-only preference — not server state.
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

function storageKey(wsId: string): string {
  return `voice-last-agent:${wsId}`;
}

interface VoiceLastAgentState {
  lastAgentByWs: Record<string, string | null>;
  hydrate: (wsId: string) => Promise<void>;
  setLastAgent: (wsId: string, agentId: string) => void;
}

export const useVoiceLastAgentStore = create<VoiceLastAgentState>(
  (set, get) => ({
    lastAgentByWs: {},
    hydrate: async (wsId) => {
      if (Object.prototype.hasOwnProperty.call(get().lastAgentByWs, wsId)) {
        return;
      }
      const stored = await SecureStore.getItemAsync(storageKey(wsId));
      set((state) => ({
        lastAgentByWs: { ...state.lastAgentByWs, [wsId]: stored },
      }));
    },
    setLastAgent: (wsId, agentId) => {
      set((state) => ({
        lastAgentByWs: { ...state.lastAgentByWs, [wsId]: agentId },
      }));
      void SecureStore.setItemAsync(storageKey(wsId), agentId);
    },
  }),
);
