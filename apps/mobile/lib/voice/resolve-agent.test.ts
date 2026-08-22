import { describe, expect, it } from "vitest";
import { resolveVoiceAgent } from "./resolve-agent";

describe("resolveVoiceAgent", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns the stored agent when it is still available", () => {
    expect(resolveVoiceAgent("b", agents)).toEqual({ id: "b" });
  });

  it("falls back to the first available agent when the stored id is gone", () => {
    expect(resolveVoiceAgent("gone", agents)).toEqual({ id: "a" });
  });

  it("falls back to the first available agent when nothing is stored", () => {
    expect(resolveVoiceAgent(null, agents)).toEqual({ id: "a" });
  });

  it("returns null when no agents are available", () => {
    expect(resolveVoiceAgent("a", [])).toBeNull();
    expect(resolveVoiceAgent(null, [])).toBeNull();
  });
});
