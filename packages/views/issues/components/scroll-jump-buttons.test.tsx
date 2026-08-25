import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enIssues from "../../locales/en/issues.json";
import { ScrollJumpButtons, SCROLL_JUMP_THRESHOLD } from "./scroll-jump-buttons";

const TEST_RESOURCES = { en: { issues: enIssues } };

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

function Harness() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <div data-testid="scroller" ref={setEl}>
        <ScrollJumpButtons container={el} />
      </div>
    </I18nProvider>
  );
}

// jsdom reports 0 for every layout metric, so the harness pins a 3000px tall
// document in a 600px viewport and moves scrollTop through it.
function layout(el: HTMLElement, scrollTop: number) {
  Object.defineProperty(el, "scrollHeight", { value: 3000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true });
  fireEvent.scroll(el);
}

const upButton = () => screen.queryByRole("button", { name: "Scroll to top" });
const downButton = () => screen.queryByRole("button", { name: "Scroll to bottom" });

describe("ScrollJumpButtons", () => {
  it("shows only the buttons for edges that are far away", () => {
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");

    act(() => layout(scroller, 0));
    expect(upButton()).not.toBeInTheDocument();
    expect(downButton()).toBeInTheDocument();

    act(() => layout(scroller, 1500));
    expect(upButton()).toBeInTheDocument();
    expect(downButton()).toBeInTheDocument();

    act(() => layout(scroller, 3000 - 600));
    expect(upButton()).toBeInTheDocument();
    expect(downButton()).not.toBeInTheDocument();
  });

  it("treats a near edge as reached within the threshold", () => {
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");
    act(() => layout(scroller, SCROLL_JUMP_THRESHOLD));
    expect(upButton()).not.toBeInTheDocument();
  });

  it("scrolls the container to the clicked edge", () => {
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    act(() => layout(scroller, 1500));

    fireEvent.click(upButton()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });

    fireEvent.click(downButton()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 3000, behavior: "smooth" });
  });
});
