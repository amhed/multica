export interface VoiceClientConfig {
  openaiApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
}

/** Default ElevenLabs voice when the user hasn't picked one in Settings. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "wBXNqKUATyqu0RtYt25i";

const KEY_LABELS = {
  openaiApiKey: "EXPO_PUBLIC_OPENAI_API_KEY",
  elevenLabsApiKey: "EXPO_PUBLIC_ELEVENLABS_API_KEY",
} as const;

export function readVoiceClientConfig(): VoiceClientConfig {
  return {
    openaiApiKey: process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? "",
    elevenLabsApiKey: process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY ?? "",
    elevenLabsVoiceId: process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? "",
  };
}

export function mergeVoiceConfig(
  stored: Partial<VoiceClientConfig> | null,
  env: VoiceClientConfig,
): VoiceClientConfig {
  const elevenLabsVoiceId =
    stored?.elevenLabsVoiceId?.trim() ||
    env.elevenLabsVoiceId.trim() ||
    DEFAULT_ELEVENLABS_VOICE_ID;
  return {
    openaiApiKey: stored?.openaiApiKey?.trim() || env.openaiApiKey,
    elevenLabsApiKey: stored?.elevenLabsApiKey?.trim() || env.elevenLabsApiKey,
    elevenLabsVoiceId,
  };
}

export function missingVoiceKeys(config: VoiceClientConfig): string[] {
  return (Object.keys(KEY_LABELS) as (keyof typeof KEY_LABELS)[]).flatMap(
    (field) => (config[field].trim() === "" ? [KEY_LABELS[field]] : []),
  );
}
