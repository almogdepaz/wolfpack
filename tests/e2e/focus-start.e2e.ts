import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer();
  mkdirSync(join(server.home, "Dev", "focus-project"), { recursive: true });
  mkdirSync(join(server.home, ".wolfpack"), { recursive: true });
  writeFileSync(join(server.home, ".wolfpack/config.json"), JSON.stringify({ devDir: join(server.home, "Dev"), port: server.port }));
  // Nothing of the focus ui shows while the assistant is off; the start rows under test need it on.
  const enabled = await fetch(`${server.baseUrl}/api/focus/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, loginConfirmed: true }) });
  if (!enabled.ok) throw new Error(`enable assistant: ${enabled.status} ${await enabled.text()}`);
});
test.afterAll(async () => { await server?.close(); });
async function addIntention(page: Page, id: string) {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const saved = await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "add", intention: { id, title: id } }] } });
  expect(saved.ok()).toBe(true);
  await page.route("**/api/settings", route => route.fulfill({ json: { effective: { cmds: ["shell"], agentCmd: "shell" } } }));
  await page.goto(server.baseUrl);
}
async function finishCreation(page: Page, name: string) {
  await page.getByRole("button", { name: "Open project focus-project", exact: true }).click();
  await page.locator("#session-name-input").fill(name);
  const response = page.waitForResponse(res => res.url().endsWith("/api/create") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Start shell", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`${server.baseUrl}/api/sessions`)).json()).sessions.some((s: { name: string }) => s.name === name)).toBe(true);
  return (await (await page.request.get(`${server.baseUrl}/api/sessions`)).json()).sessions.find((s: { name: string }) => s.name === name).identity;
}

test("title-only start completes creation and CAS-links its exact identity, chosen project and machine", async ({ page }) => {
  await addIntention(page, "linked-focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: /start.*linked-focus/ }).click();
  let conflicted = false;
  let conflictStatus: number | undefined;
  await page.route("**/api/focus", async route => {
    const op = route.request().method() === "POST" ? route.request().postDataJSON().ops?.[0] : undefined;
    const conflict = !conflicted && op?.type === "edit" && op.id === "linked-focus";
    if (conflict) {
      conflicted = true;
      const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
      expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "edit", id: "linked-focus", patch: { sessions: ["prior-linked-session"] } }] } })).ok()).toBe(true);
    }
    const response = await route.fetch();
    if (conflict) conflictStatus = response.status();
    await route.fulfill({ response });
  });
  const identity = await finishCreation(page, "focus-created");
  await expect.poll(async () => (await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).document.intentions.find((i: { id: string }) => i.id === "linked-focus").sessions).toEqual(["prior-linked-session", identity.wolfpackSessionId]);
  expect(conflictStatus).toBe(409);
  const focus = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const intention = focus.document.intentions.find((i: { id: string }) => i.id === "linked-focus");
  expect(intention.project).toBe(identity.projectPath);
  expect(intention.machine).toBe((await (await page.request.get(`${server.baseUrl}/api/info`)).json()).name);
  await page.goto(server.baseUrl);
  await expect(page.locator("#dashboard-focus").getByRole("button", { name: /start.*linked-focus/ })).toHaveCount(0);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-content .focus-today li").filter({ hasText: "linked-focus" }).getByRole("button", { name: "focus-created", exact: true })).toBeVisible();
});

test("cancelling focus start does not associate an unrelated subsequent creation", async ({ page }) => {
  await addIntention(page, "cancelled-focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: /start.*cancelled-focus/ }).click();
  await page.locator("#projects-view .picker-cancel-btn").click();
  await page.locator("#session-list .machine-add-btn").first().click();
  await finishCreation(page, "unrelated-created");
  const focus = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect(focus.document.intentions.find((i: { id: string }) => i.id === "cancelled-focus")).not.toHaveProperty("sessions");
});

test("a focus-link write failure reports a created session separately from failed focus persistence", async ({ page }) => {
  await addIntention(page, "failed-link-focus");
  await page.locator("#dashboard-focus").getByRole("button", { name: /start.*failed-link-focus/ }).click();
  await page.route("**/api/focus", route => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "focus store unavailable" } }) : route.continue());
  await finishCreation(page, "created-despite-link-failure");
  await expect(page.locator("#app-dialog-title")).toHaveText("Session created; focus not updated");
  await expect(page.locator("#app-dialog-message")).toContainText("focus store unavailable");
  await expect(page.locator("#agent-create-error")).not.toContainText("Failed to create session");
});
