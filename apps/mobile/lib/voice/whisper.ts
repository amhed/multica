import { z } from "zod";

const WhisperResponseSchema = z.object({
  text: z.string(),
});

const TRANSCRIBE_TIMEOUT_MS = 45_000;

/**
 * OpenAI Whisper transcription. Called from the device with a local
 * EXPO_PUBLIC_OPENAI_API_KEY — personal-build only; do not ship this
 * path in a store client.
 */
export async function transcribeAudio(
  uri: string,
  apiKey: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);

  const form = new FormData();
  form.append("file", {
    uri,
    name: "speech.m4a",
    type: "audio/m4a",
  } as unknown as Blob);
  form.append("model", "whisper-1");

  try {
    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Whisper failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const parsed = WhisperResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Whisper returned an unexpected response.");
    }
    const text = parsed.data.text.trim();
    if (!text) {
      throw new Error("I couldn't hear anything. Try again.");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
