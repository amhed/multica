import { describe, expect, it } from "vitest";
import { toSpeakableText } from "./speakable-text";

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
});
