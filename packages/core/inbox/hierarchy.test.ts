// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildInboxHierarchy } from "./hierarchy";
import type { InboxItem, InboxIssueAncestor } from "../types/inbox";

const ancestor = (id: string): InboxIssueAncestor => ({ id, title: id, status: "in_progress" });
const item = (id: string, age: number, ancestors: string[] = [], overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: `notification-${id}`, workspace_id: "ws", recipient_type: "member", recipient_id: "user",
  actor_type: "agent", actor_id: "agent", type: "mentioned", severity: "info", issue_id: id,
  title: id, body: null, issue_status: "in_progress", read: false, archived: false,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, age)).toISOString(), details: null,
  issue_ancestors: ancestors.map(ancestor), ...overrides,
});
const ids = (rows: ReturnType<typeof buildInboxHierarchy>) => rows.map(r => r.issue?.id ?? r.item?.id);

describe("inbox hierarchy", () => {
  it("moves the whole effort with its newest child while keeping the parent first", () => {
    const rows = buildInboxHierarchy([item("unrelated", 20), item("child", 30, ["parent"]), item("parent", 1), item("older-child", 10, ["parent"])]);
    expect(ids(rows)).toEqual(["parent", "child", "older-child", "unrelated"]);
    expect(rows[0]).toMatchObject({ childCount: 2, unreadCount: 3, depth: 0 });
    expect(rows[1]).toMatchObject({ depth: 1, ancestorKeys: ["ws:issue:parent"] });
  });

  it("restores missing, filtered, or archived parents as context, without adding unread items", () => {
    const rows = buildInboxHierarchy([item("child", 30, ["parent", "root"])]);
    expect(ids(rows)).toEqual(["root", "parent", "child"]);
    expect(rows[0]).toMatchObject({ item: null, childCount: 1, unreadCount: 1 });
    expect(rows[1]).toMatchObject({ item: null, childCount: 1, unreadCount: 1 });
    expect(rows.filter(r => r.item)).toHaveLength(1);
  });

  it("collapses descendants but retains counts and reveals a selected deep link", () => {
    const items = [item("child", 30, ["parent", "root"])];
    const collapsed = new Set(["ws:issue:root", "ws:issue:parent"]);
    expect(ids(buildInboxHierarchy(items, collapsed))).toEqual(["root"]);
    expect(buildInboxHierarchy(items, collapsed)[0]).toMatchObject({ collapsed: true, unreadCount: 1 });
    expect(ids(buildInboxHierarchy(items, collapsed, "child"))).toEqual(["root", "parent", "child"]);
  });

  it("keeps legacy rows and issue-less notifications visible", () => {
    const rows = buildInboxHierarchy([item("root", 1, [], { issue_ancestors: undefined }), item("notice", 2, [], { issue_id: null })]);
    expect(ids(rows)).toEqual(["notification-notice", "root"]);
  });

  it("isolates equal issue IDs in different workspaces", () => {
    const rows = buildInboxHierarchy([item("child", 3, ["parent"]), item("child", 2, ["parent"], { workspace_id: "other" })]);
    expect(new Set(rows.map(r => r.key)).size).toBe(4);
    expect(rows.map(r => r.workspaceId)).toEqual(["ws", "ws", "other", "other"]);
  });

  it("terminates self and cross-notification cycles without hiding issues", () => {
    const rows = buildInboxHierarchy([item("a", 1, ["b", "a"]), item("b", 2, ["a", "b"]), item("self", 3, ["self"])]);
    expect(new Set(ids(rows))).toEqual(new Set(["a", "b", "self"]));
    expect(rows).toHaveLength(3);
  });

  it("rebuilds ancestry after reparenting and uses the real notification read state", () => {
    const before = buildInboxHierarchy([item("child", 1, ["old"], { read: true })]);
    const after = buildInboxHierarchy([item("child", 1, ["new"], { read: true })]);
    expect(ids(before)).toEqual(["old", "child"]);
    expect(ids(after)).toEqual(["new", "child"]);
    expect(after[0]?.unreadCount).toBe(0);
  });
});
