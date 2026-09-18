import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { TestApiClient } from "./fixtures";

// Real API, database, and browser coverage. Pure ancestry edge cases belong in
// core/inbox/hierarchy.test.ts and handler/inbox_test.go.
test("inbox groups preserve context, selection, and individual notification actions", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const evidence = process.env.INBOX_EVIDENCE_DIR ?? testInfo.outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  const api = new TestApiClient();
  const db = new pg.Client(process.env.DATABASE_URL ?? "postgres://multica:multica@localhost:5432/multica?sslmode=disable");
  await db.connect();
  const notificationIds: string[] = [];
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("requestfailed", (request) => browserErrors.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  const suffix = `${Date.now()}-${testInfo.workerIndex}`;
  const session = await api.login(`inbox-${suffix}@multica.ai`, "Inbox Reviewer");
  const workspace = await api.ensureWorkspace("Inbox Review", `inbox-${suffix}`);
  await api.markUserOnboarded();
  const token = api.getToken()!;
  const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Workspace-ID": workspace.id },
    });
    expect(response.ok, `${path}: ${response.status}`).toBe(true);
    return response.json();
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" });
  };
  try {
    const root = await api.createIssue("Launch readiness", { status: "in_progress" });
    const parent = await api.createIssue("Checkout reliability", { parent_issue_id: root.id, status: "in_progress" });
    const child = await api.createIssue("Retry payment safely", { parent_issue_id: parent.id, status: "in_review", priority: "high" });
    const sibling = await api.createIssue("Confirm receipt delivery", { parent_issue_id: parent.id, status: "todo" });
    const independent = await api.createIssue("Update release notes", { status: "todo" });
    const comment = await request(`/api/issues/${child.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: `[@Inbox Reviewer](mention://member/${session.user.id}) **ready** for review`, type: "comment" }),
    });
    // Seed representative notifications, then exercise production endpoints for
    // every read/archive action. No browser API routes are mocked.
    for (const [issue, age] of [[parent, 40], [child, 1], [sibling, 30], [independent, 10]] as const) {
      const result = await db.query(
        `INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, actor_type, actor_id,
          type, severity, issue_id, title, body, details, created_at)
         VALUES ($1, 'member', $2, 'member', $2, $3, 'info', $4, $5, $6, $7, now() - $8 * interval '1 minute') RETURNING id`,
        [workspace.id, session.user.id, issue.id === child.id ? "new_comment" : "issue_assigned",
          issue.id, issue.title, issue.id === child.id ? comment.content : null,
          issue.id === child.id ? JSON.stringify({ comment_id: comment.id }) : null, age],
      );
      notificationIds.push(result.rows[0].id);
    }
    const [parentNotification, childNotification, siblingNotification, independentNotification] = notificationIds;
    const before = await request("/api/inbox");
    expect(before.find((item: { id: string }) => item.id === childNotification).issue_ancestors.map((ancestor: { id: string }) => ancestor.id)).toEqual([parent.id, root.id]);
    expect(before.find((item: { id: string }) => item.id === independentNotification).issue_ancestors).toBeUndefined();
    await writeFile(join(evidence, "inbox-api-before.json"), JSON.stringify(before, null, 2));

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript((authToken) => {
      localStorage.setItem("multica_token", authToken);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, token);
    await page.goto(`/${workspace.slug}/inbox`, { waitUntil: "domcontentloaded" });
    const list = page.locator('[data-tab-scroll-root="list"]');
    const row = (title: string) => list.locator('[role="button"]').filter({ has: page.getByText(title, { exact: true }) });
    await expect(list.getByText(child.title, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(list.getByRole("link", { name: /Launch readiness/ })).toBeVisible();
    await expect(list.getByRole("button", { name: "Collapse Launch readiness", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(list.getByRole("button", { name: "Collapse Checkout reliability", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Inbox actions", exact: true })).toBeVisible();
    await expect(row(child.title)).toContainText("@Inbox Reviewer ready for review");
    await expect(row(child.title)).not.toContainText("mention://");
    const visibleOrder = await list.locator('[role="button"]').evaluateAll((rows) => rows.map((element) => element.textContent));
    expect(visibleOrder.map((text) => [parent, child, sibling, independent].find((issue) => text?.includes(issue.title))?.id)).toEqual([parent.id, child.id, sibling.id, independent.id]);
    await capture("01-expanded-desktop");
    await page.setViewportSize({ width: 640, height: 950 });
    await capture("02-expanded-compact");
    await page.setViewportSize({ width: 1440, height: 1000 });

    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page).toHaveURL(new RegExp(`issue=${parent.id}`));
    await page.keyboard.press("ArrowDown");
    await expect(page).toHaveURL(new RegExp(`issue=${child.id}`));
    await expect.poll(async () => (await request("/api/inbox")).find((item: { id: string }) => item.id === childNotification).read).toBe(true);
    const afterSelection = await request("/api/inbox");
    expect(afterSelection.find((item: { id: string }) => item.id === parentNotification).read).toBe(true);
    expect(afterSelection.find((item: { id: string }) => item.id === siblingNotification).read).toBe(false);
    await capture("03-keyboard-child-selected");

    await page.getByRole("button", { name: "Filter inbox", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: /Unread only/ }).click();
    await page.keyboard.press("Escape");
    await expect(list.getByText(child.title, { exact: true })).toHaveCount(0);
    await expect(list.getByRole("link", { name: /Checkout reliability/ })).toBeVisible();
    await expect(list.getByText(sibling.title, { exact: true })).toBeVisible();
    await capture("04-filtered-ancestor-context");
    await page.getByRole("button", { name: "1 active filter", exact: true }).click();
    await page.getByRole("menuitem", { name: /Clear filters/ }).click();
    await page.keyboard.press("Escape");

    await row(child.title).click();
    await list.getByRole("button", { name: "Collapse Launch readiness", exact: true }).click();
    await expect(list.getByText(child.title, { exact: true })).toHaveCount(0);
    await expect(page).not.toHaveURL(/issue=/);
    await capture("05-collapsed-group");
    // Same-document navigation preserves the collapsed store, as a desktop
    // notification or browser-history navigation does.
    await page.evaluate((href) => window.history.pushState(null, "", href), `/${workspace.slug}/inbox?issue=${child.id}`);
    await expect(list.getByText(child.title, { exact: true })).toBeVisible();
    await expect(list.getByRole("button", { name: "Collapse Launch readiness", exact: true })).toHaveAttribute("aria-expanded", "true");
    await capture("06-deep-link-revealed");

    await row(child.title).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).click();
    await expect.poll(async () => (await request("/api/inbox")).find((item: { id: string }) => item.id === childNotification).read).toBe(false);
    await row(child.title).hover();
    await row(child.title).getByRole("button", { name: "Archive", exact: true }).click();
    await expect.poll(async () => (await request("/api/inbox/archived")).some((item: { id: string }) => item.id === childNotification)).toBe(true);
    const persisted = await db.query("SELECT id, issue_id, read, archived FROM inbox_item WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC", [notificationIds]);
    expect(persisted.rows.find((item) => item.id === childNotification).archived).toBe(true);
    expect(persisted.rows.find((item) => item.id === childNotification).read).toBe(false);
    expect(persisted.rows.filter((item) => item.id !== childNotification).every((item) => item.archived === false)).toBe(true);
    await writeFile(join(evidence, "notification-state-after-archive.json"), JSON.stringify(persisted.rows, null, 2));
    await list.getByRole("button", { name: /Archived/ }).click();
    await expect(list.getByRole("link", { name: /Checkout reliability/ })).toBeVisible();
    await expect(list.getByText(child.title, { exact: true })).toBeVisible();
    await capture("07-archived-child-context");
    await row(child.title).hover();
    await row(child.title).getByRole("button", { name: "Unarchive", exact: true }).click();
    await expect.poll(async () => (await request("/api/inbox")).some((item: { id: string }) => item.id === childNotification)).toBe(true);
    await expect(page).toHaveURL(/view=archived/);
    await expect(page.getByText("No archived notifications", { exact: true })).toBeVisible();
    await expect(list.getByText(child.title, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Archived", exact: true }).click();
    await expect(page).not.toHaveURL(/view=archived/);
    await list.getByRole("button", { name: "Expand Launch readiness", exact: true }).click();
    await expect(list.getByText(child.title, { exact: true })).toBeVisible();

    // Changes arrive over the live WebSocket; no reload or query invalidation
    // from the test should be necessary to refresh context and reparenting.
    await api.updateIssue(root.id, { title: "Launch readiness verified" });
    await expect(list.getByRole("link", { name: /Launch readiness verified/ })).toBeVisible();
    await api.updateIssue(child.id, { parent_issue_id: independent.id });
    await expect(list.getByRole("button", { name: "Collapse Update release notes", exact: true })).toBeVisible();
    const afterReparent = await request("/api/inbox");
    expect(afterReparent.find((item: { id: string }) => item.id === childNotification).issue_ancestors.map((ancestor: { id: string }) => ancestor.id)).toEqual([independent.id]);
    await capture("08-realtime-reparenting");
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true });
    await writeFile(testInfo.outputPath("browser-errors.json"), JSON.stringify(browserErrors, null, 2));
    throw error;
  } finally {
    await db.query("DELETE FROM inbox_item WHERE id = ANY($1::uuid[])", [notificationIds]);
    await api.cleanup();
    await db.end();
  }
});
