import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StagingDeployCard } from "./staging-deploy-card";

// react-i18next isn't initialised in the views test env, so resolve the
// selector against the en/layout.json copy the widget uses.
vi.mock("../i18n", () => ({
  useT: () => ({
    t: (sel: (r: { sidebar: { deploy: Record<string, string> } }) => string) =>
      sel({
        sidebar: {
          deploy: {
            title: "Staging deploy",
            success: "Deploy succeeded",
            failed: "Deploy failed",
            cancelled: "Deploy cancelled",
            running: "Deploy running",
          },
        },
      }),
  }),
  useTimeAgo: () => () => "2h ago",
}));
vi.mock("../navigation", () => ({
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
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
  schema: "multica.deploy.v1",
  workflow: "Deploy to Staging",
  run: {
    status: "completed",
    conclusion: "success",
    url: "https://github.com/o/r/actions/runs/1",
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:05:00Z",
    actor: "amhed",
    ref: "fix/p3-9",
  },
  pr: { number: 197, title: "fix(P3-9): simulator (LAP-304)", url: "https://github.com/o/r/pull/197" },
  issueIdentifier: "LAP-304",
};

describe("StagingDeployCard", () => {
  it("renders nothing without a snapshot or without a run", () => {
    snapshot.current = null;
    const { container, rerender } = render(<StagingDeployCard />);
    expect(container).toBeEmptyDOMElement();
    snapshot.current = { ...fixture, run: null };
    rerender(<StagingDeployCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links the run, the issue in the current workspace, and the PR", () => {
    snapshot.current = fixture;
    render(<StagingDeployCard />);

    expect(screen.getByRole("link", { name: "Deploy succeeded" })).toHaveAttribute(
      "href",
      "https://github.com/o/r/actions/runs/1",
    );
    expect(screen.getByText("2h ago")).toBeInTheDocument();
    expect(screen.getByText("fix/p3-9")).toBeInTheDocument();
    expect(screen.getByText("amhed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LAP-304" })).toHaveAttribute("href", "/acme/issues/LAP-304");
    expect(screen.getByRole("link", { name: /#197/ })).toHaveAttribute("href", "https://github.com/o/r/pull/197");
  });

  it("shows a running state and skips absent links", () => {
    snapshot.current = {
      ...fixture,
      run: { ...fixture.run, status: "in_progress", conclusion: null },
      pr: null,
      issueIdentifier: null,
    };
    render(<StagingDeployCard />);
    expect(screen.getByRole("link", { name: "Deploy running" })).toBeInTheDocument();
    expect(screen.queryByText("LAP-304")).not.toBeInTheDocument();
    expect(screen.queryByText(/#197/)).not.toBeInTheDocument();
  });

  it("marks a failed run", () => {
    snapshot.current = { ...fixture, run: { ...fixture.run, conclusion: "failure" } };
    render(<StagingDeployCard />);
    expect(screen.getByRole("link", { name: "Deploy failed" })).toBeInTheDocument();
  });
});
