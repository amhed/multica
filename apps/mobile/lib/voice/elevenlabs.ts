import { File, Paths } from "expo-file-system";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";

const SPEAK_TIMEOUT_MS = 45_000;
const FLASH_MODEL = "eleven_flash_v2_5";

/**
 * ElevenLabs TTS. Called from the device with local
 * EXPO_PUBLIC_ELEVENLABS_* keys — personal-build only.
 */
export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  voiceId: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: FLASH_MODEL,
          apply_text_normalization: "on",
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = new File(Paths.cache, `voice-tts-${Date.now()}.mp3`);
    file.create({ overwrite: true });
    file.write(bytes);
    return file.uri;
  } finally {
    clearTimeout(timer);
  }
}

export async function playSpeechUri(uri: string): Promise<AudioPlayer> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
  });
  const player = createAudioPlayer({ uri });
  player.play();
  return player;
}
