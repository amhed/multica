import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  mergeVoiceConfig,
  missingVoiceKeys,
  type VoiceClientConfig,
} from "./config";

describe("missingVoiceKeys", () => {
  const complete: VoiceClientConfig = {
    openaiApiKey: "sk-test",
    elevenLabsApiKey: "el-test",
    elevenLabsVoiceId: "voice-1",
  };

  it("returns an empty list when every key is present", () => {
    expect(missingVoiceKeys(complete)).toEqual([]);
  });

  it("names each missing key", () => {
    expect(
      missingVoiceKeys({
        openaiApiKey: "",
        elevenLabsApiKey: "  ",
        elevenLabsVoiceId: "voice-1",
      }),
    ).toEqual(["EXPO_PUBLIC_OPENAI_API_KEY", "EXPO_PUBLIC_ELEVENLABS_API_KEY"]);
  });
});

describe("mergeVoiceConfig", () => {
  const env: VoiceClientConfig = {
    openaiApiKey: "sk-env",
    elevenLabsApiKey: "el-env",
    elevenLabsVoiceId: "voice-env",
  };

  it("prefers non-empty stored keys over env", () => {
    expect(
      mergeVoiceConfig(
        {
          openaiApiKey: "sk-stored",
          elevenLabsApiKey: "",
          elevenLabsVoiceId: "  ",
        },
        env,
      ),
    ).toEqual({
      openaiApiKey: "sk-stored",
      elevenLabsApiKey: "el-env",
      elevenLabsVoiceId: "voice-env",
    });
  });

  it("uses the default ElevenLabs voice when nothing is set", () => {
    expect(
      mergeVoiceConfig(null, {
        openaiApiKey: "sk-env",
        elevenLabsApiKey: "el-env",
        elevenLabsVoiceId: "",
      }).elevenLabsVoiceId,
    ).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
  });
});

