import { describe, expect, it } from "vitest";
import { missingVoiceKeys, type VoiceClientConfig } from "./config";

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
