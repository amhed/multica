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
const workspaceSlug = { current: "acme" };
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
  useWorkspaceSlug: () => workspaceSlug.current,
}));

const snapshot = { current: undefined as unknown };
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: snapshot.current }),
}));

afterEach(() => {
  snapshot.current = undefined;
  workspaceSlug.current = "acme";
});

const alpha = {
  repo: "tinydevelopersllc/segurohq",
  workspace: null,
  workflow: "Deploy to staging",
  run: {
    status: "completed",
    conclusion: "success",
    url: "https://github.com/tinydevelopersllc/segurohq/actions/runs/1",
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:05:00Z",
    actor: "amhed",
    headSha: "1a30d1c",
  },
  pr: { number: 195, title: "fix(SEG-222): decode bytea", url: "https://github.com/tinydevelopersllc/segurohq/pull/195" },
  issueIdentifier: "SEG-222",
};
const beta = {
  repo: "tinydevelopersllc/venue-site",
  workspace: null,
  workflow: "Deploy staging",
  run: { ...alpha.run, status: "in_progress", conclusion: null, url: "https://github.com/tinydevelopersllc/venue-site/actions/runs/2" },
  pr: null,
  issueIdentifier: null,
};
const fixture = { schema: "multica.deploy.v2", deploys: [alpha, beta] };

describe("StagingDeployCard", () => {
  it("renders nothing without a snapshot or without deploys", () => {
    snapshot.current = null;
    const { container, rerender } = render(<StagingDeployCard />);
    expect(container).toBeEmptyDOMElement();
    snapshot.current = { ...fixture, deploys: [] };
    rerender(<StagingDeployCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one row per repo, linking the run, the issue in the current workspace, and the PR", () => {
    snapshot.current = fixture;
    render(<StagingDeployCard />);

    expect(screen.getByRole("link", { name: "segurohq: Deploy succeeded" })).toHaveAttribute(
      "href",
      "https://github.com/tinydevelopersllc/segurohq/actions/runs/1",
    );
    expect(screen.getByRole("link", { name: "venue-site: Deploy running" })).toHaveAttribute(
      "href",
      "https://github.com/tinydevelopersllc/venue-site/actions/runs/2",
    );
    expect(screen.getAllByText("2h ago")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "SEG-222" })).toHaveAttribute("href", "/acme/issues/SEG-222");
    expect(screen.getByRole("link", { name: /#195/ })).toHaveAttribute(
      "href",
      "https://github.com/tinydevelopersllc/segurohq/pull/195",
    );
    // venue-site has no PR or issue, so only one of each link exists.
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("shows a workspace-bound row only in its workspace, and unbound rows everywhere", () => {
    snapshot.current = {
      ...fixture,
      deploys: [{ ...alpha, workspace: "segurohq" }, { ...beta, workspace: "la-pagina" }],
    };
    workspaceSlug.current = "la-pagina";
    const { container, rerender } = render(<StagingDeployCard />);
    expect(screen.getByText("venue-site")).toBeInTheDocument();
    expect(screen.queryByText("segurohq")).not.toBeInTheDocument();

    workspaceSlug.current = "segurohq";
    rerender(<StagingDeployCard />);
    expect(screen.getByText("segurohq")).toBeInTheDocument();
    expect(screen.queryByText("venue-site")).not.toBeInTheDocument();

    // Neither row belongs to this workspace, so the strip disappears entirely.
    workspaceSlug.current = "other";
    rerender(<StagingDeployCard />);
    expect(container).toBeEmptyDOMElement();

    snapshot.current = { ...fixture, deploys: [alpha, { ...beta, workspace: "la-pagina" }] };
    rerender(<StagingDeployCard />);
    expect(screen.getByText("segurohq")).toBeInTheDocument();
    expect(screen.queryByText("venue-site")).not.toBeInTheDocument();
  });

  it("marks a failed run", () => {
    snapshot.current = { ...fixture, deploys: [{ ...alpha, run: { ...alpha.run, conclusion: "failure" } }] };
    render(<StagingDeployCard />);
    expect(screen.getByRole("link", { name: "segurohq: Deploy failed" })).toBeInTheDocument();
  });
});
