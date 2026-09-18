import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { TestApiClient } from "./fixtures";

test("fork commands, active summaries, and off-page archived hierarchy survive the upstream merge", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const evidence = process.env.INBOX_EVIDENCE_DIR ?? testInfo.outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  const api = new TestApiClient();
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  const session = await api.login(`fork-${Date.now()}@multica.ai`, "Fork Reviewer");
  const workspace = await api.ensureWorkspace("Fork integration", `fork-${Date.now()}`);
  await api.markUserOnboarded();
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${api.getToken()}`, "X-Workspace-ID": workspace.id },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
    return response.status === 204 ? null : response.json();
  };
  const capture = (name: string) => page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" });
  try {
    const parent = await api.createIssue("Upstream release acceptance", { status: "in_progress" });
    const child = await api.createIssue("Preserve fork workflow", { parent_issue_id: parent.id, status: "todo" });
    const shipped = await request("/api/issue-statuses", "POST", { key: "shipped", name: "Shipped", category: "done", color: "#22aa66" });
    await request(`/api/issue-statuses/${shipped.id}`, "PATCH", { position: -100 });
    // Fixtures have no connected daemon and cannot execute an installed agent.
    const runtime = (await db.query("INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, owner_id) VALUES ($1, 'Offline test runtime', 'local', 'claude_code', $2) RETURNING id", [workspace.id, session.user.id])).rows[0].id;
    const agent = (await db.query("INSERT INTO agent (workspace_id, name, runtime_mode, runtime_id, owner_id) VALUES ($1, 'Release Reviewer', 'local', $2, $3) RETURNING id", [workspace.id, runtime, session.user.id])).rows[0].id;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken()!);
    await page.goto(`/${workspace.slug}/issues/${child.id}`);
    await expect(page.getByText(child.title, { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    const command = async (query: string, label: string) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Type a command or search...").fill(query);
      await expect(page.getByRole("option", { name: label, exact: true })).toBeVisible();
      await capture(`command-${query.replaceAll(" ", "-")}`);
      await page.getByRole("option", { name: label, exact: true }).click();
    };
    const transitions: unknown[] = [];
    for (const [key, label] of [["in_progress", "In Progress"], ["in_review", "In Review"], ["blocked", "Blocked"], ["todo", "Todo"], ["shipped", "Done"]]) {
      await command(label.toLowerCase(), `Mark as ${label}`);
      await expect.poll(async () => (await request(`/api/issues/${child.id}`)).status).toBe(key);
      const result = await request(`/api/issues/${child.id}`);
      transitions.push({ command: `Mark as ${label}`, status: result.status, category: result.status_category });
    }
    await command("assign", "Assign to Release Reviewer");
    await expect.poll(async () => (await request(`/api/issues/${child.id}`)).assignee_id).toBe(agent);
    await writeFile(join(evidence, "command-status-results.json"), JSON.stringify({ transitions, assignment: await request(`/api/issues/${child.id}`) }, null, 2));
    const summary = "Verify the upstream merge while preserving fork workflows.";
    await db.query("INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, started_at, pstack_summary) VALUES ($1, $2, $3, 'running', now(), $4)", [agent, child.id, runtime, summary]);
    await page.goto(`/${workspace.slug}/active`);
    await expect(page.getByRole("button", { name: summary, exact: true })).toBeVisible();
    await capture("active-board-summary");
    await page.context().addCookies([{ name: "multica-locale", value: "fr", url: process.env.FRONTEND_ORIGIN! }]);
    await page.reload();
    await expect(page.getByRole("button", { name: summary, exact: true })).toBeVisible();
    await expect(page.getByText(/^En cours ·/)).toBeVisible();
    await capture("active-board-french");
    await page.context().addCookies([{ name: "multica-locale", value: "en", url: process.env.FRONTEND_ORIGIN! }]);

    await db.query("DELETE FROM inbox_item WHERE workspace_id = $1", [workspace.id]);
    await db.query("INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, title, archived, created_at) SELECT $1, 'member', $2, 'mentioned', 'info', 'Recent archived notification ' || n, true, now() FROM generate_series(1,55) n", [workspace.id, session.user.id]);
    await db.query("INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, title, issue_id, archived, created_at) VALUES ($1, 'member', $2, 'issue_assigned', 'info', $3, $4, true, now() - interval '1 day')", [workspace.id, session.user.id, child.title, child.id]);
    const first = await request("/api/inbox/archived/page?limit=50");
    expect(first.has_more).toBe(true);
    expect(first.items.some((item: { issue_id: string }) => item.issue_id === child.id)).toBe(false);
    const second = await request(`/api/inbox/archived/page?limit=50&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(second.items.find((item: { issue_id: string }) => item.issue_id === child.id).issue_ancestors[0].id).toBe(parent.id);
    await writeFile(join(evidence, "paginated-archive.json"), JSON.stringify({ first, second }, null, 2));
    const lookupResponse = page.waitForResponse((response) => response.url().includes("/api/inbox/archived/page?") && response.url().includes(`group_id=${child.id}`));
    await page.goto(`/${workspace.slug}/inbox?view=archived&issue=${child.id}`);
    const lookup = await (await lookupResponse).json();
    expect(lookup.items[0].issue_ancestors[0].id).toBe(parent.id);
    await writeFile(join(evidence, "archived-deep-link-lookup.json"), JSON.stringify(lookup, null, 2));
    const list = page.locator('[data-tab-scroll-root="list"]');
    await expect(page.getByText(child.title, { exact: true }).first()).toBeVisible();
    // Archive rows are virtualized; the targeted lookup is appended after
    // the loaded page, so scroll to it before asserting the rendered context.
    const nextPage = page.waitForResponse((response) => response.url().includes("/api/inbox/archived/page?") && response.url().includes("cursor="));
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await nextPage;
    await expect(list.getByRole("button", { name: /^(Load more|Loading…)$/ })).toHaveCount(0);
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(list.getByText(child.title, { exact: true })).toBeVisible();
    await expect(list.getByRole("link", { name: new RegExp(parent.title) })).toBeVisible();
    await list.getByText(child.title, { exact: true }).scrollIntoViewIfNeeded();
    await capture("archived-off-page-deep-link");
    await page.goto(`/${workspace.slug}/usage`);
    const subscriptions = page.getByRole("button", { name: "Subscriptions", exact: true });
    await expect(subscriptions).toHaveAttribute("aria-pressed", "false");
    await subscriptions.click();
    await expect(subscriptions).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(subscriptions).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Edit subscription fees", exact: true }).click();
    await expect(page.getByText("Replace metered cost with the flat monthly fee", { exact: false })).toBeVisible();
    await page.getByRole("spinbutton", { name: "Claude $ / month", exact: true }).fill("250");
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(subscriptions).toContainText("$450/mo");
    await page.getByRole("button", { name: "Edit subscription fees", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "Claude $ / month", exact: true })).toHaveValue("250");
    await capture("subscription-pricing");
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true });
    throw error;
  } finally {
    await api.cleanup();
    await request(`/api/workspaces/${workspace.id}`, "DELETE");
    await db.end();
  }
});
