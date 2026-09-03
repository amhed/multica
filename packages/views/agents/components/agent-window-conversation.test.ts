// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { TraceStep } from "../../common/task-transcript/build-steps";
import { buildConversation } from "./agent-window-conversation";

let seq = 0;
function call(tool: string, input: Record<string, unknown>, output?: string): TraceStep {
  seq += 1;
  return {
    kind: "call",
    seq,
    tool,
    call: { seq, type: "tool_use", tool, input } as never,
    result: output === undefined ? undefined : ({ seq: seq + 100, type: "tool_result", output } as never),
  };
}
function text(content: string): TraceStep {
  seq += 1;
  return { kind: "text", seq, item: { seq, type: "text", content } as never, startedAt: "2026-09-03T10:00:00Z" };
}
function error(content: string): TraceStep {
  seq += 1;
  return { kind: "error", seq, item: { seq, type: "error", content } as never };
}

describe("buildConversation", () => {
  it("keeps agent text as bubbles and folds tool runs between them into typed blocks", () => {
    const blocks = buildConversation([
      text("Reading the list command first."),
      call("Read", { file_path: "a.go" }),
      call("Edit", { file_path: "a.go" }),
      call("Edit", { file_path: "a_test.go" }),
      call("Edit", { file_path: "a.go" }),
      call("Bash", { command: "go test ./..." }, "ok"),
      call("mcp__linear__get_issue", { id: "MUL-1" }),
      text("Tests pass."),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["agent_text", "files", "commands", "other", "agent_text"]);
    expect(blocks[1]).toMatchObject({ kind: "files", paths: ["a.go", "a_test.go"] });
    expect(blocks[2]).toMatchObject({ kind: "commands", runs: [{ command: "go test ./...", ok: null }] });
    expect(blocks[3]).toMatchObject({ kind: "other", steps: [{ verb: "read" }, { verb: "used" }] });
  });

  it("surfaces errors as their own block, with unknown command outcome", () => {
    const blocks = buildConversation([call("Bash", { command: "pnpm test" }, "1 failed"), error("Tool crashed")]);
    expect(blocks[0]).toMatchObject({ kind: "commands", runs: [{ command: "pnpm test", ok: null }] });
    expect(blocks[1]).toMatchObject({ kind: "error", text: "Tool crashed" });
  });

  it("reports unknown outcome as null and skips thinking", () => {
    const thinking: TraceStep = { kind: "thinking", seq: 99, item: { seq: 99, type: "thinking", content: "hmm" } as never };
    const blocks = buildConversation([thinking, call("Bash", { command: "make up" })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "commands", runs: [{ command: "make up", ok: null }] });
  });
});
