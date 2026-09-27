import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, ListIssuesParams } from "@multica/core/types";

const { listIssues } = vi.hoisted(() => ({ listIssues: vi.fn() }));
vi.mock("@/data/api", () => ({ api: { listIssues } }));

import { ISSUE_CATEGORY_PAGE_SIZE, listIssuesByCategory } from "./issues";

const issue = (id: string, status: string) => ({ id, status }) as Issue;

describe("listIssuesByCategory", () => {
  beforeEach(() => {
    listIssues.mockReset();
    listIssues.mockImplementation(async (params: ListIssuesParams) => {
      const byCategory: Record<string, Issue[]> = {
        unstarted: [issue("u1", "todo")],
        started: [issue("s1", "in_progress")],
        done: [issue("d1", "done"), issue("d2", "done")],
        closed: [issue("c1", "cancelled")],
      };
      const issues = byCategory[params.status_category ?? ""] ?? [];
      return { issues, total: issues.length };
    });
  });

  // Regression: one unfiltered request is capped server-side and ordered by
  // position, so Done (which gains a new top rank on every transition) filled
  // the whole page and open issues never reached the phone.
  it("requests every lifecycle category separately so Done cannot crowd out open issues", async () => {
    const signal = new AbortController().signal;
    const result = await listIssuesByCategory({ project_id: "p1" }, signal);

    expect(listIssues).toHaveBeenCalledTimes(4);
    for (const category of ["unstarted", "started", "done", "closed"]) {
      expect(listIssues).toHaveBeenCalledWith(
        {
          project_id: "p1",
          status_category: category,
          limit: ISSUE_CATEGORY_PAGE_SIZE,
          offset: 0,
        },
        { signal },
      );
    }
    expect(result.map((i) => i.id)).toEqual(["u1", "s1", "d1", "d2", "c1"]);
  });
});
