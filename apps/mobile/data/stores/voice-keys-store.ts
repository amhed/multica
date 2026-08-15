/**
 * On-device Voice API keys. SecureStore is the source of truth; env vars
 * are only a fallback via mergeVoiceConfig. Personal-build only.
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import type { VoiceClientConfig } from "@/lib/voice/config";

const STORAGE_KEY = "voice-client-keys";

export type VoiceStoredKeys = Pick<
  VoiceClientConfig,
  "openaiApiKey" | "elevenLabsApiKey" | "elevenLabsVoiceId"
>;

const EMPTY_KEYS: VoiceStoredKeys = {
  openaiApiKey: "",
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "",
};

interface VoiceKeysState {
  keys: VoiceStoredKeys;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  save: (keys: VoiceStoredKeys) => Promise<void>;
}

export const useVoiceKeysStore = create<VoiceKeysState>((set) => ({
  keys: EMPTY_KEYS,
  hydrated: false,
  hydrate: async () => {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) {
      set({ keys: EMPTY_KEYS, hydrated: true });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VoiceStoredKeys>;
      set({
        keys: {
          openaiApiKey: parsed.openaiApiKey ?? "",
          elevenLabsApiKey: parsed.elevenLabsApiKey ?? "",
          elevenLabsVoiceId: parsed.elevenLabsVoiceId ?? "",
        },
        hydrated: true,
      });
    } catch {
      set({ keys: EMPTY_KEYS, hydrated: true });
    }
  },
  save: async (keys) => {
    const next: VoiceStoredKeys = {
      openaiApiKey: keys.openaiApiKey.trim(),
      elevenLabsApiKey: keys.elevenLabsApiKey.trim(),
      elevenLabsVoiceId: keys.elevenLabsVoiceId.trim(),
    };
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    set({ keys: next, hydrated: true });
  },
}));
