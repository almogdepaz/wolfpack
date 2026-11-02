import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { collapseInitialSessionMenu, startTestServer, type TestServer } from "./helpers.ts";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ canonicalSessionIds: true }); });
test.afterAll(async () => { await server?.close(); });
async function draft(page: Page, value: string) {
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "New group…" });
  await page.getByLabel("Group", { exact: true }).fill(value);
}
async function openEditor(page: Page) {
  await page.goto(server.baseUrl);
  const button = page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first();
  await expect(button).toBeVisible(); await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Move test-project to group", exact: true })).toBeVisible();
}

test("organization saves canonical groups through real API and preserves stored tags", async ({ page, request }) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, tags: ["urgent"] } })).ok()).toBe(true);
  await openEditor(page); await draft(page, " ops ");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const group = page.locator('#session-list .session-label-group[data-group="ops"]');
  await expect(group).toContainText("test-project");
  await expect(page.getByText("urgent", { exact: true })).toHaveCount(0);
  await openEditor(page);
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("ops");
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "Ungrouped" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const saved = await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${session.sessionId}`)).json();
  expect(saved.organization.group).toBeNull(); expect(saved.organization.tags).toEqual(["urgent"]);
});

test("organization conflict preserves draft and explicit reload reviews server values", async ({ page, request }) => {
  await openEditor(page); await draft(page, "my draft");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  const saved = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "other browser", tags: ["concurrent tag"] } });
  expect(saved.ok()).toBe(true);
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("my draft");
  await page.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Latest saved" })).toContainText("other browser");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("my draft");
  await page.getByRole("button", { name: "Use latest", exact: true }).click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("other browser");
  await draft(page, "reviewed move");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${session.sessionId}`)).json()).organization.tags).toEqual(["concurrent tag"]);
});

test("organization touch editor bounds Unicode safely and escapes group text and attributes", async ({ page }, info) => {
  await page.goto(server.baseUrl);
  const button = page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first();
  if (info.project.use.hasTouch) await button.tap(); else await button.click();
  const dialog = page.getByRole("dialog", { name: "Move test-project to group" });
  await draft(page, "😀".repeat(65));
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("64");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("😀".repeat(65));
  await page.getByLabel("Group", { exact: true }).fill("😀".repeat(64));
  const accessibility = await new AxeBuilder({ page }).include('.organization-dialog').analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("organization.png") });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await button.click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("😀".repeat(64));
  await draft(page, '<img src=x onerror=alert(1)>"&');
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.session-label-group img')).toHaveCount(0);
  await expect(page.locator('#session-list .session-group-name').filter({ hasText: '<img src=x onerror=alert(1)>"&' })).toBeVisible();
  if (info.project.use.hasTouch) await page.locator('.mobile-session-search summary').click();
  const search = page.getByRole("searchbox", { name: "Search sessions" }).filter({ visible: true });
  await search.fill("test-project");
  await expect(page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true })).toHaveCount(1);
});

test("maximum valid session name keeps organization actions inside the dialog", async ({ page, request }, info) => {
  const name = "x".repeat(100);
  const projectDir = join(server.home, name); mkdirSync(projectDir);
  const created = await request.post(`${server.baseUrl}/api/session-create`, { data: { projectDir, harness: "shell" } });
  expect(created.ok()).toBe(true); expect((await created.json()).session).toBe(name);
  await page.goto(server.baseUrl);
  const invoker = page.getByRole("button", { name: `Move ${name} to group`, exact: true }).filter({ visible: true }).first();
  await invoker.click();
  const dialog = page.getByRole("dialog", { name: `Move ${name} to group`, exact: true });
  await expect(dialog.getByRole("heading")).toHaveText(`Move ${name} to group`);
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const label of ["Move", "Cancel"]) {
    const action = dialog.getByRole("button", { name: label, exact: true }); await action.scrollIntoViewIfNeeded();
    const bounds = await action.evaluate(element => {
      const box = element.getBoundingClientRect(); const parent = element.closest("dialog")!.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, parentLeft: parent.left, parentRight: parent.right, parentTop: parent.top, parentBottom: parent.bottom };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.parentLeft); expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight);
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.parentTop); expect(bounds.bottom).toBeLessThanOrEqual(bounds.parentBottom);
  }
  await page.screenshot({ path: info.outputPath("organization-long-session-name.png") });
  await draft(page, "long title saved"); await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(invoker).toBeFocused();
  await invoker.click(); await expect(page.getByLabel("Group", { exact: true })).toHaveValue("long title saved");
  await draft(page, "cancelled edit"); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(invoker).toBeFocused();
  await invoker.click(); await expect(page.getByLabel("Group", { exact: true })).toHaveValue("long title saved");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("organization sidebar save keeps its group and restores the exact action focus", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar ownership only");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "before sidebar save", tags: ["one", "two", "three"] } })).ok()).toBe(true);
  await page.goto(server.baseUrl); await collapseInitialSessionMenu(page);
  const button = page.locator('#sidebar-session-list').getByRole("button", { name: "Move test-project to group", exact: true });
  const original = await button.elementHandle(); expect(original).not.toBeNull(); await button.click();
  await draft(page, "sidebar saved"); await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect.poll(() => original!.evaluate(element => element.isConnected)).toBe(false); await expect(button).toBeFocused();
  await expect(page.locator('#sidebar-session-list .session-label-group[data-group="sidebar saved"]')).toContainText("test-project");
  expect(await button.evaluate(element => element.closest('.card')!.querySelector('.card-name-text')!.getBoundingClientRect().width)).toBeGreaterThanOrEqual(100);
  await page.screenshot({ path: info.outputPath("organization-sidebar.png") });
});

test("organization failure retains input, cancels safely, and returns keyboard focus", async ({ page }) => {
  await openEditor(page);
  await page.route("**/api/session-control/organization", route => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { code: "ORGANIZATION_UNAVAILABLE", error: "disk unavailable" } }) : route.continue());
  await draft(page, "retained draft"); await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("read"); await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained draft");
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first()).toBeFocused();
});
