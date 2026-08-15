export interface VoiceClientConfig {
  openaiApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
}

const KEY_LABELS = {
  openaiApiKey: "EXPO_PUBLIC_OPENAI_API_KEY",
  elevenLabsApiKey: "EXPO_PUBLIC_ELEVENLABS_API_KEY",
  elevenLabsVoiceId: "EXPO_PUBLIC_ELEVENLABS_VOICE_ID",
} as const;

export function readVoiceClientConfig(): VoiceClientConfig {
  return {
    openaiApiKey: process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? "",
    elevenLabsApiKey: process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY ?? "",
    elevenLabsVoiceId: process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? "",
  };
}

export function missingVoiceKeys(config: VoiceClientConfig): string[] {
  return (Object.keys(KEY_LABELS) as (keyof typeof KEY_LABELS)[]).flatMap(
    (field) => (config[field].trim() === "" ? [KEY_LABELS[field]] : []),
  );
}
