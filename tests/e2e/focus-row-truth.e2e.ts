import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const [state, inputKind, label, verb] of [
  ["needs-input", "permission", "permission", "approve"],
  ["needs-input", "question", "question", "answer"],
  ["needs-input", "auth", "auth", "log in"],
  ["needs-input", undefined, "needs you", "open"],
  ["failed", "permission", "failed", "retry"],
  ["done", "question", "stopped", "review"],
  ["idle", undefined, "stopped", "review"],
] as const) test(`row truth: ${state}/${inputKind ?? "unknown"} says ${label} and ${verb}`, async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const s = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    s.runtimeState = { ...s.runtimeState, state, inputKind, unseen: true, stoppedSequence: 5,
      acknowledgedSequence: 0, changedAt: new Date(Date.now() - 720_000).toISOString() };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  await expect(row.locator("summary .focus-title")).toHaveText(`prompt-project ${label} · 12m`);
  await expect(row.getByRole("button", { name: `${verb} prompt-project ${label}`, exact: true })).toHaveText(`${verb} ›`);
  await expect(block.getByRole("button", { name: "start “fix broker leak”", exact: true })).toHaveText("start ›");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const action = page.locator("#assistant-content").getByRole("button", { name: `${verb} prompt-project ${label}`, exact: true });
  await expect(action).toHaveText(`${verb} ›`);
  await expect(page.locator("#sidebar-assistant .assistant-tile-next")).toContainText(`prompt-project ${label}`);
  // All verbs navigate through the existing session opener, including retry (not a restart).
  const socket = page.waitForEvent("websocket", { predicate: ws => new URL(ws.url()).searchParams.get("session") === "prompt-project" });
  await action.click();
  await socket;
  await expect(page.locator("#terminal-view")).toBeVisible();
});
