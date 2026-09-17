// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inboxCommentPreview } from "./inbox-preview";

describe("inboxCommentPreview", () => {
  it.each([
    ["[@Codex Senior Dev](mention://agent/123) take a look", "@Codex Senior Dev take a look"],
    ["[@David\\[TF\\]](mention://agent/123)", "@David[TF]"],
    ["[MUL-123](mention://issue/123) **needs** `review`", "MUL-123 needs review"],
    ["## Update\n\nSee [docs](https://example.com)\n\n- Ready", "Update See docs Ready"],
    ["Please ask [@Codex](mention://agent/long-identifier…", "Please ask @Codex"],
    ["![design](https://example.com/image.png)", "design"],
    ["<script>alert(1)</script>", ""],
    ["你好 👋", "你好 👋"],
    ["First  \nsecond", "First second"],
    ["```\ncode\n```\n\nFollowing paragraph", "code Following paragraph"],
  ])("renders %s as readable text", (input, expected) => {
    expect(inboxCommentPreview(input)).toBe(expected);
  });
});
