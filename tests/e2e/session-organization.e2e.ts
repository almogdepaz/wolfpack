import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { collapseInitialSessionMenu, startTestServer, type TestServer } from "./helpers.ts";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ canonicalSessionIds: true }); });
test.afterAll(async () => { await server?.close(); });
async function openEditor(page: Page) {
  await page.goto(server.baseUrl);
  const button = page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true }).first();
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Organize test-project", exact: true })).toBeVisible();
}

test("organization saves canonical labels through real API and survives reload on every chooser", async ({ page }) => {
  await openEditor(page);
  await page.getByLabel("Group", { exact: true }).fill(" ops ");
  await page.getByLabel("New tag", { exact: true }).fill("urgent");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove tag urgent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const visibleCard = page.locator('.card').filter({ has: page.getByRole("button", { name: "Open test-project", exact: true }) }).filter({ visible: true }).first();
  await expect(visibleCard).toContainText("ops");
  await expect(visibleCard).toContainText("urgent");
  await openEditor(page);
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("ops");
  await expect(page.getByRole("button", { name: "Remove tag urgent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear group", exact: true }).click();
  await page.getByRole("button", { name: "Remove tag urgent", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("organization conflict preserves draft and explicit reload reviews server values", async ({ page, request }) => {
  await openEditor(page);
  await page.getByLabel("Group", { exact: true }).fill("my draft");
  const sessions = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.sessions.find((s: any) => s.session === "test-project");
  const saved = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "other browser" } });
  expect(saved.ok()).toBe(true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("my draft");
  await page.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Latest saved" })).toContainText("other browser");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("my draft");
  await page.getByRole("button", { name: "Use latest", exact: true }).click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("other browser");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("organization touch editor bounds Unicode safely and reveals overflow without filtering", async ({ page }, info) => {
  await page.goto(server.baseUrl);
  const button = page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true }).first();
  if (info.project.use.hasTouch) await button.tap(); else await button.click();
  const dialog = page.getByRole("dialog", { name: "Organize test-project" });
  const group = page.getByLabel("Group", { exact: true });
  await group.fill("😀".repeat(65));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("64");
  await expect(group).toHaveValue("😀".repeat(65));
  await group.fill("😀".repeat(64));
  for (const tag of ["<img src=x onerror=alert(1)>", "one", "two", "three"]) {
    await page.getByLabel("New tag", { exact: true }).fill(tag);
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
  }
  await expect(dialog.locator("img")).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).include('.organization-dialog').analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("organization.png") });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.session-organization img')).toHaveCount(0);
  await page.getByRole("button", { name: "Show all labels for test-project", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("button", { name: "Remove tag three", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  if (info.project.use.hasTouch) await page.locator('.mobile-session-search summary').click();
  const search = page.getByRole("searchbox", { name: "Search sessions" }).filter({ visible: true });
  await search.fill("one");
  await expect(page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true })).toHaveCount(1);
});

test("maximum valid session name keeps organization actions inside the dialog", async ({ page, request }, info) => {
  const name = "x".repeat(100);
  const projectDir = join(server.home, name);
  mkdirSync(projectDir);
  const created = await request.post(`${server.baseUrl}/api/session-create`, { data: { projectDir, harness: "shell" } });
  expect(created.ok()).toBe(true);
  expect((await created.json()).session).toBe(name);
  await page.goto(server.baseUrl);
  const invoker = page.getByRole("button", { name: `Organize ${name}`, exact: true }).filter({ visible: true }).first();
  await invoker.click();
  const dialog = page.getByRole("dialog", { name: `Organize ${name}`, exact: true });
  await expect(dialog.getByRole("heading")).toHaveText(`Organize ${name}`);
  console.log("long-name-dialog", await dialog.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })));
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const label of ["Save", "Cancel"]) {
    const action = dialog.getByRole("button", { name: label, exact: true });
    await action.scrollIntoViewIfNeeded();
    const bounds = await action.evaluate(element => {
      const box = element.getBoundingClientRect();
      const parent = element.closest("dialog")!.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, parentLeft: parent.left, parentRight: parent.right, parentTop: parent.top, parentBottom: parent.bottom };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.parentLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight);
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.parentTop);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.parentBottom);
  }
  await page.screenshot({ path: info.outputPath("organization-long-session-name.png") });
  await page.getByLabel("Group", { exact: true }).fill("long title saved");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(invoker).toBeFocused();
  await invoker.click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("long title saved");
  await page.getByLabel("Group", { exact: true }).fill("cancelled edit");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(invoker).toBeFocused();
  await invoker.click();
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("long title saved");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("organization sidebar save keeps its labels and restores the exact action focus", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar ownership only");
  await page.goto(server.baseUrl);
  await collapseInitialSessionMenu(page);
  const button = page.locator('#sidebar-session-list').getByRole("button", { name: "Organize test-project", exact: true });
  await button.click();
  await page.getByLabel("Group", { exact: true }).fill("sidebar saved");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(button).toBeFocused();
  await expect(page.locator('#sidebar-session-list .card').filter({ has: page.getByRole("button", { name: "Organize test-project", exact: true }) })).toContainText("sidebar saved");
});

test("organization failure retains input, cancels safely, and returns keyboard focus", async ({ page }) => {
  await openEditor(page);
  await page.route("**/api/session-control/organization", route => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { code: "ORGANIZATION_UNAVAILABLE", error: "disk unavailable" } }) : route.continue());
  await page.getByLabel("Group", { exact: true }).fill("retained draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("read");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Organize test-project", exact: true }).filter({ visible: true }).first()).toBeFocused();
});
