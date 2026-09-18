import { forwardRef, useImperativeHandle, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import { buildInboxHierarchy, type InboxHierarchyRow } from "@multica/core/inbox/hierarchy";
import { InboxList } from "./inbox-list";

// jsdom has no layout, so the real Virtuoso measures a 0-height viewport and
// renders nothing. The mock renders every row inline and exposes the handle
// methods the list drives, so the keyboard behaviour is observable.
const scrollIntoView = vi.hoisted(() => vi.fn());

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    {
      data,
      itemContent,
      components,
      endReached,
    }: {
      components: { Footer: React.ComponentType };
      endReached: () => void;
      data: InboxHierarchyRow[];
      itemContent: (index: number, item: InboxHierarchyRow) => React.ReactNode;
    },
    ref: React.Ref<unknown>,
  ) {
    useImperativeHandle(ref, () => ({ scrollIntoView }));
    return (
      <div>
        <button onClick={endReached}>Reach list end</button>
        {data.map((item, index) => (
          <div key={item.key}>{itemContent(index, item)}</div>
        ))}
        <components.Footer />
      </div>
    );
  }),
}));

// The row renders avatars, hover cards, and a status icon — none of which this
// file is about. Keep it a bare button carrying the two things the list reads.
vi.mock("./inbox-list-item", () => ({
  InboxListItem: ({
    item,
    isSelected,
    onClick,
  }: {
    item: InboxItem;
    isSelected: boolean;
    onClick: () => void;
  }) => (
    <button type="button" data-selected={isSelected} onClick={onClick}>
      {item.id}
    </button>
  ),
}));

vi.mock("./inbox-parent-context", () => ({ InboxParentContext: ({ issue }: { issue: { title: string } }) => <a href="#parent">{issue.title}</a> }));

vi.mock("../../i18n", async () => {
  const strings = (await import("../../locales/en/inbox.json")).default;
  return { useT: () => ({ t: (select: (value: typeof strings) => string) => select(strings) }) };
});

function item(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    workspace_id: "workspace-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: `issue-${id}`,
    title: "Issue title",
    body: null,
    issue_status: null,
    read: true,
    archived: false,
    created_at: "2026-06-15T08:00:00Z",
    details: null,
    ...overrides,
  };
}

const items = [item("a"), item("b"), item("c")];

function renderList(selectedKey: string, onSelect = vi.fn()) {
  const utils = render(
    <InboxList
      rows={buildInboxHierarchy(items)}
      onToggleGroup={vi.fn()}
      view="inbox"
      selectedKey={selectedKey}
      onSelect={onSelect}
      onAction={vi.fn()}
      onOpenArchived={vi.fn()}
    />,
  );
  // The scroll container owns the key handler; it is the row's closest
  // ancestor with an overflow style.
  const scroller = utils.container.querySelector(".overflow-y-auto") as HTMLElement;
  return { ...utils, scroller, onSelect };
}

/** Press a key on the list, reporting whether the native scroll was claimed. */
function press(scroller: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  return !fireEvent.keyDown(scroller, { key, ...init });
}

beforeEach(() => {
  scrollIntoView.mockClear();
});

describe("InboxList keyboard navigation", () => {
  it("moves the selection down instead of scrolling", () => {
    const { scroller, onSelect } = renderList("issue-a");

    const prevented = press(scroller, "ArrowDown");

    expect(onSelect).toHaveBeenCalledWith(items[1]);
    expect(prevented).toBe(true);
  });

  it("moves the selection up", () => {
    const { scroller, onSelect } = renderList("issue-b");

    press(scroller, "ArrowUp");

    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("enters the list from either end when nothing is selected", () => {
    const down = renderList("");
    press(down.scroller, "ArrowDown");
    expect(down.onSelect).toHaveBeenCalledWith(items[0]);

    const up = renderList("");
    press(up.scroller, "ArrowUp");
    expect(up.onSelect).toHaveBeenCalledWith(items[2]);
  });

  it("stops at the ends of the list and still claims the key", () => {
    // Falling through to the native scroll at the last row would move the
    // viewport away from the row that stays selected.
    const { scroller, onSelect } = renderList("issue-c");

    const prevented = press(scroller, "ArrowDown");

    expect(onSelect).not.toHaveBeenCalled();
    expect(prevented).toBe(true);
  });

  it("scrolls the newly selected row into view", () => {
    // Virtuoso's own scrollIntoView, so a row that virtualization has not
    // mounted still gets there — and only when it is off-screen.
    const { scroller } = renderList("issue-a");

    press(scroller, "ArrowDown");

    expect(scrollIntoView).toHaveBeenCalledWith({ index: 1 });
  });

  it("leaves modified arrow keys alone", () => {
    // Shift+Down extends a selection and Alt/Cmd+Down are OS/browser scroll
    // accelerators; none of them mean "next notification".
    const { scroller, onSelect } = renderList("issue-a");

    expect(press(scroller, "ArrowDown", { shiftKey: true })).toBe(false);
    expect(press(scroller, "ArrowDown", { metaKey: true })).toBe(false);
    expect(press(scroller, "ArrowDown", { altKey: true })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves the key to a text field inside the list", () => {
    const { scroller, onSelect } = renderList("issue-a");
    const input = document.createElement("input");
    scroller.appendChild(input);

    press(input, "ArrowDown");

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores an arrow key that composition already owns", () => {
    // During IME composition the arrow key walks the candidate list.
    const { scroller, onSelect } = renderList("issue-a");

    press(scroller, "ArrowDown", { keyCode: 229 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("focuses the container on click so the arrow keys work right after", () => {
    // Safari does not focus a <button> on click, and virtualization can unmount
    // the clicked row — either way the keydown would stop reaching the list.
    const { scroller, onSelect } = renderList("");

    fireEvent.click(screen.getByText("b"));

    expect(onSelect).toHaveBeenCalledWith(items[1]);
    expect(document.activeElement).toBe(scroller);
  });
});


// The hierarchy edge-case matrix lives in core/inbox/hierarchy.test.ts.
// Here we exercise disclosure and virtualized keyboard navigation together.
it("collapses with a real disclosure button and skips context during arrow navigation", () => {
  const child = item("child", { issue_ancestors: [{ id: "parent", title: "Parent context", status: "todo" }] });
  const other = item("other", { created_at: "2026-06-14T08:00:00Z" });
  const onSelect = vi.fn();
  function Harness() {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    return <InboxList rows={buildInboxHierarchy([child, other], collapsed)} view="inbox" selectedKey=""
      onSelect={onSelect} onAction={vi.fn()} onOpenArchived={vi.fn()}
      onToggleGroup={row => setCollapsed(row.collapsed ? new Set() : new Set([row.key]))} />;
  }
  render(<Harness />);
  const disclosure = screen.getByRole("button", { name: "Collapse {{title}}" });
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: "Parent context" })).toBeInTheDocument();
  const scroller = document.querySelector<HTMLElement>('[data-tab-scroll-root="list"]')!;
  press(scroller, "ArrowDown");
  expect(onSelect).toHaveBeenLastCalledWith(child);
  expect(scrollIntoView).toHaveBeenLastCalledWith({ index: 1 });
  onSelect.mockClear();
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "child" })).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
  press(scroller, "ArrowDown");
  expect(onSelect).toHaveBeenLastCalledWith(other);
  fireEvent.click(disclosure);
  expect(screen.getByRole("button", { name: "child" })).toBeInTheDocument();
});

describe("InboxList archive pagination", () => {
  it("keeps a count-free archive entry available with an empty inbox", () => {
    const onOpenArchived = vi.fn();
    render(<InboxList rows={[]} onToggleGroup={vi.fn()} view="inbox" selectedKey="" onSelect={vi.fn()} onAction={vi.fn()} onOpenArchived={onOpenArchived} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(onOpenArchived).toHaveBeenCalledOnce();
  });

  it("loads at the end, suppresses automatic retries, and provides a retry button", () => {
    const onLoadMore = vi.fn();
    const props = { rows: buildInboxHierarchy(items), onToggleGroup: vi.fn(), view: "archived" as const, selectedKey: "", onSelect: vi.fn(), onAction: vi.fn(), onOpenArchived: vi.fn(), onLoadMore };
    const { rerender } = render(<InboxList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Reach list end" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    onLoadMore.mockClear();
    rerender(<InboxList {...props} loadMoreError />);
    fireEvent.click(screen.getByRole("button", { name: "Reach list end" }));
    expect(onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(screen.getByText("a")).toBeTruthy();
  });

  it("loads the next page when restored rows drain the loaded window", () => {
    const onLoadMore = vi.fn();
    render(<InboxList rows={[]} onToggleGroup={vi.fn()} view="archived" selectedKey="" onSelect={vi.fn()} onAction={vi.fn()} onOpenArchived={vi.fn()} onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(screen.queryByText("No archived notifications")).toBeNull();
  });
});
