import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const [state, inputKind, unseen, label, verb] of [
  ["needs-input", "permission", true, "permission", "approve"],
  ["needs-input", "question", true, "question", "answer"],
  ["needs-input", "auth", true, "auth", "log in"],
  ["needs-input", undefined, true, "needs you", "open"],
  ["failed", "permission", true, "failed", "retry"],
  ["idle", undefined, true, undefined, undefined],
  ["done", undefined, true, undefined, undefined],
  ["done", undefined, false, undefined, undefined],
] as const) test(`pinned counts: ${state}/${inputKind ?? "unknown"}/${unseen ? "unseen" : "seen"} ${label ? "ranks" : "stays out"}`, async ({ page }, info) => {
  const width = info.project.name === "desktop" ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  const count = label ? 1 : 0;
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.pinned = true;
    session.runtimeState = { ...session.runtimeState, state, inputKind, unseen, stoppedSequence: 5,
      acknowledgedSequence: unseen ? 0 : 5, changedAt: new Date().toISOString(), stale: false, freshness: "fresh",
      authority: state === "idle" ? "fallback" : "program", source: state === "idle" ? "screen-fallback" : "program-status" };
    // The assistant must stay excluded even when its own pinned process needs input.
    const assistant = body.sessions.find((s: { name: string }) => s.name === "assistant");
    assistant.runtimeState = { ...assistant.runtimeState, state: "needs-input", inputKind: "permission" };
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    // Keep a working linked session to avoid a start row. Linking the pinned session
    // also proves that a reviewed done session cannot become a seen-finish row.
    body.document.intentions = [{ id: "pinned", title: "Pinned helper", done: false, createdAt: new Date().toISOString(),
      sessions: ["mock:prompt-project", "mock:another-project"] }];
    delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="need"] .n')).toHaveAttribute("data-count", state === "needs-input" ? "1" : "0");
  await expect(page.locator('#sidebar-session-filter [data-session-card-view="fail"] .n')).toHaveAttribute("data-count", state === "failed" ? "1" : "0");
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText(`${count} next${count ? ":" : ""}`);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(count);
  await expect(block.locator(":scope > small").last()).toContainText(`${count} next`);
  if (label) await expect(block.getByRole("button", { name: `${verb} prompt-project ${label}`, exact: true })).toHaveText(`${verb} ›`);
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next > li")).toHaveCount(count);
  await expect(view.locator(":scope > h2").first()).toHaveText(`next ${count}`);
  if (label) await expect(view.getByRole("button", { name: `${verb} prompt-project ${label}`, exact: true })).toHaveText(`${verb} ›`);
  else await expect(view.locator(".focus-next, .focus-done")).toHaveCount(0);
  if (process.env.WOLFPACK_FOCUS_SHOTS && (inputKind === "permission" || state === "idle")) {
    mkdirSync(process.env.WOLFPACK_FOCUS_SHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.WOLFPACK_FOCUS_SHOTS, `pinned-${state}-${width}.png`), fullPage: true });
  }
});
