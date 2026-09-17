import type { InboxItem, InboxIssueAncestor } from "../types/inbox";

export interface InboxHierarchyRow {
  key: string;
  workspaceId: string;
  issue: InboxIssueAncestor | null;
  item: InboxItem | null;
  depth: number;
  ancestorKeys: string[];
  childCount: number;
  unreadCount: number;
  collapsed: boolean;
}

interface Node {
  key: string;
  workspaceId: string;
  issue: InboxIssueAncestor | null;
  item: InboxItem | null;
  parentKey?: string;
  children: Node[];
  newest: number;
  count: number;
  unread: number;
}

const issueKey = (ws: string, id: string) => `${ws}:issue:${id}`;

/** Filter notifications first; ancestor metadata restores context without inventing notifications. */
export function buildInboxHierarchy(
  items: readonly InboxItem[],
  collapsedKeys: ReadonlySet<string> = new Set(),
  selectedKey = "",
): InboxHierarchyRow[] {
  const nodes = new Map<string, Node>();
  const ensure = (key: string, workspaceId: string, issue: InboxIssueAncestor | null) => {
    let node = nodes.get(key);
    if (!node) {
      node = { key, workspaceId, issue, item: null, children: [], newest: 0, count: 0, unread: 0 };
      nodes.set(key, node);
    }
    return node;
  };
  // Notifications take precedence over ancestor copies for title and status.
  for (const item of items) {
    const key = item.issue_id ? issueKey(item.workspace_id, item.issue_id) : `${item.workspace_id}:notification:${item.id}`;
    const node = ensure(key, item.workspace_id, null);
    node.item = item;
    node.issue = item.issue_id ? { id: item.issue_id, title: item.title, status: item.issue_status ?? "" } : null;
    node.newest = Date.parse(item.created_at) || 0;
    node.count = 1;
    node.unread = item.read === true ? 0 : 1;
  }
  for (const item of items) {
    if (!item.issue_id) continue;
    let child = nodes.get(issueKey(item.workspace_id, item.issue_id))!;
    const visited = new Set([item.issue_id]);
    for (const ancestor of item.issue_ancestors ?? []) {
      if (visited.has(ancestor.id)) break;
      visited.add(ancestor.id);
      const parent = ensure(issueKey(item.workspace_id, ancestor.id), item.workspace_id, ancestor);
      // First path wins if a response contains inconsistent ancestor snapshots.
      child.parentKey ??= parent.key;
      child = parent;
    }
  }
  // Cut cycles once, including cycles assembled from different notification paths.
  const settled = new Set<string>();
  for (const node of nodes.values()) {
    const path = new Set<string>();
    let cursor: Node | undefined = node;
    while (cursor && !settled.has(cursor.key)) {
      path.add(cursor.key);
      if (cursor.parentKey && path.has(cursor.parentKey)) { cursor.parentKey = undefined; break; }
      cursor = cursor.parentKey ? nodes.get(cursor.parentKey) : undefined;
    }
    for (const key of path) settled.add(key);
  }
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Iterative postorder handles deep trees without exhausting the JS call stack.
  const traversal: Node[] = [];
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    traversal.push(node);
    for (const child of node.children) pending.push(child);
  }
  const compare = (a: Node, b: Node) => b.newest - a.newest || a.key.localeCompare(b.key);
  for (let i = traversal.length - 1; i >= 0; i--) {
    const node = traversal[i]!;
    for (const child of node.children) {
      node.newest = Math.max(node.newest, child.newest);
      node.count += child.count;
      node.unread += child.unread;
    }
    node.children.sort(compare);
  }
  roots.sort(compare);
  const revealed = new Set<string>();
  for (const node of nodes.values()) {
    if (!node.item || (node.item.issue_id ?? node.item.id) !== selectedKey) continue;
    let parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    while (parent) {
      revealed.add(parent.key);
      parent = parent.parentKey ? nodes.get(parent.parentKey) : undefined;
    }
  }
  const rows: InboxHierarchyRow[] = [];
  const stack = roots.map(node => ({ node, ancestorKeys: [] as string[] })).reverse();
  while (stack.length) {
    const { node, ancestorKeys } = stack.pop()!;
    const collapsed = collapsedKeys.has(node.key) && !revealed.has(node.key);
    rows.push({ key: node.key, workspaceId: node.workspaceId, issue: node.issue, item: node.item,
      depth: ancestorKeys.length, ancestorKeys, childCount: node.count - (node.item ? 1 : 0),
      unreadCount: node.unread, collapsed });
    if (!collapsed) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i]!, ancestorKeys: [...ancestorKeys, node.key] });
      }
    }
  }
  return rows;
}
