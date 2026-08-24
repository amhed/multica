import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enIssues from "../../locales/en/issues.json";
import { ScrollToTopButton, SCROLL_TO_TOP_THRESHOLD } from "./scroll-to-top-button";

const TEST_RESOURCES = { en: { issues: enIssues } };

function Harness() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <div data-testid="scroller" ref={setEl}>
        <ScrollToTopButton container={el} />
      </div>
    </I18nProvider>
  );
}

function scrollTo(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollTop", { value: top, configurable: true, writable: true });
  fireEvent.scroll(el);
}

describe("ScrollToTopButton", () => {
  it("stays hidden at the top and appears once the container scrolls past the threshold", () => {
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");
    expect(screen.queryByRole("button", { name: "Scroll to top" })).not.toBeInTheDocument();

    act(() => scrollTo(scroller, SCROLL_TO_TOP_THRESHOLD + 1));
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeInTheDocument();

    act(() => scrollTo(scroller, 0));
    expect(screen.queryByRole("button", { name: "Scroll to top" })).not.toBeInTheDocument();
  });

  it("scrolls the container back to the top when clicked", () => {
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");
    const scrollToSpy = vi.fn();
    scroller.scrollTo = scrollToSpy;

    act(() => scrollTo(scroller, SCROLL_TO_TOP_THRESHOLD + 1));
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
