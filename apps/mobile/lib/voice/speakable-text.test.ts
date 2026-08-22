import { describe, expect, it } from "vitest";
import { toSpeakableText, withVoiceReplyInstruction } from "./speakable-text";

describe("toSpeakableText", () => {
  it("returns plain text unchanged", () => {
    expect(toSpeakableText("Hello there.")).toBe("Hello there.");
  });

  it("strips markdown emphasis and headings", () => {
    expect(toSpeakableText("## Hello **world** and _you_")).toBe(
      "Hello world and you",
    );
  });

  it("keeps link labels and drops the URL", () => {
    expect(toSpeakableText("See [the docs](https://example.com) later.")).toBe(
      "See the docs later.",
    );
  });

  it("omits fenced code blocks", () => {
    expect(
      toSpeakableText("Before\n```ts\nconst x = 1;\n```\nAfter"),
    ).toBe("Before After");
  });

  it("strips inline code markers", () => {
    expect(toSpeakableText("Run `make start` next.")).toBe("Run make start next.");
  });

  it("drops images", () => {
    expect(toSpeakableText("Here ![alt](https://img.test/a.png) we go.")).toBe(
      "Here we go.",
    );
  });

  it("returns empty string for blank or whitespace-only input", () => {
    expect(toSpeakableText("")).toBe("");
    expect(toSpeakableText("   \n")).toBe("");
  });

  it("speaks a short file name instead of a path", () => {
    expect(
      toSpeakableText("I updated apps/mobile/lib/voice/speakable-text.ts today."),
    ).toBe("I updated speakable text today.");
  });

  it("does not read a long absolute path aloud", () => {
    expect(
      toSpeakableText(
        "See /Users/amhed/src/multica/apps/mobile/app/(app)/[workspace]/(tabs)/voice.tsx next.",
      ),
    ).toBe("See voice next.");
  });

  it("replaces UUIDs and raw URLs", () => {
    expect(
      toSpeakableText(
        "Open https://example.com/docs and id 550e8400-e29b-41d4-a716-446655440000.",
      ),
    ).toBe("Open a link and id an id.");
  });
});

describe("withVoiceReplyInstruction", () => {
  it("appends the spoken-reply instruction after the transcript", () => {
    const result = withVoiceReplyInstruction("List my open issues");
    expect(result.startsWith("List my open issues")).toBe(true);
    expect(result).toContain("file paths");
    expect(result).toContain("long filenames");
  });
});
