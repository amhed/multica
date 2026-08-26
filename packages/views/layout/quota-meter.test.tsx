import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaMeter } from "./quota-meter";

// react-i18next isn't initialised in the views test env, so resolve the
// selector against the en/layout.json copy the widget uses.
vi.mock("../i18n", () => ({
  useT: () => ({
    t: (
      sel: (r: { sidebar: { quota: Record<string, string> } }) => string,
      vars?: Record<string, string>,
    ) => {
      const raw = sel({
        sidebar: {
          quota: {
            title: "Provider quota",
            stale: "Stale",
            session: "Session",
            weekly: "Weekly",
            credits: "Credits",
            resets: "Resets {{when}}",
          },
        },
      });
      return raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars?.[k] ?? "");
    },
  }),
}));

const snapshot = { current: undefined as unknown };
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: snapshot.current }),
}));

afterEach(() => {
  snapshot.current = undefined;
});

const fixture = {
  schema: "openusage.limits.v1",
  stale: false,
  providers: {
    claude: {
      displayName: "Claude",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 57, limit: 100, utilization: 0.57 },
        weekly: { kind: "consumption", unit: "percent", used: 85, limit: 100, utilization: 0.85 },
      },
    },
    codex: {
      displayName: "Codex",
      resources: {
        weekly: { kind: "consumption", unit: "percent", utilization: 0.02 },
        credits: { kind: "balance", unit: "credits", available: 0 },
      },
    },
    grok: {
      displayName: "Grok",
      resources: { extraUsage: { kind: "balance", unit: "credits", available: 12 } },
    },
  },
};

describe("QuotaMeter", () => {
  it("renders nothing without a snapshot", () => {
    snapshot.current = null;
    const { container } = render(<QuotaMeter />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a bar per consumption window and a balance for balance-only providers", () => {
    snapshot.current = fixture;
    render(<QuotaMeter />);

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("57%")).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("2%")).toBeInTheDocument();
    // Claude has session + weekly, Codex has weekly: three bars in total.
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    // One track per bar: the shared Progress already draws its own, so the
    // widget must not add a second one (regression: doubled bars in the sidebar).
    expect(document.querySelectorAll('[data-slot="progress-track"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-slot="progress-indicator"]')).toHaveLength(3);
    // Grok has no consumption window, so its balance is shown inline instead.
    expect(screen.getByText("12 Credits")).toBeInTheDocument();
    // Codex has a bar, so its zero credit balance does not compete with it.
    expect(screen.queryByText("0 Credits")).not.toBeInTheDocument();
  });

  it("flags a stale snapshot", () => {
    snapshot.current = { ...fixture, stale: true };
    render(<QuotaMeter />);
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });
});
