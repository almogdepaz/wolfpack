import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { expandFocusCard } from "./focus-card-helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("full merge is classified before the cap; delegated stops wait and starts live in today", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "1"));
  const at = "2026-11-11T10:00:00Z";
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [
    ...current.document.intentions.map((i: { id: string }) => ({ type: "drop", id: i.id })),
    ...Array.from({ length: 6 }, (_, i) => ({ type: "add", intention: { id: `start-${i}`, title: `Unstarted ${i}` } })),
    { type: "next", author: "assistant", rows: [{ ref: { machine: current.installationId, sessionId: "mock:quiet-finish" }, stoppedAt: at, verdict: "quiet", reason: "The documentation is complete" }] },
  ] } })).ok()).toBe(true);
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    const rows = [
      ["api-refactor", "idle", undefined], ["worker", "working", "api-refactor"], ["child-finish", "done", "api-refactor"],
      ["urgent", "needs-input", "api-refactor"], ["orphan-finish", "done", "gone"], ["quiet-finish", "done", undefined],
    ];
    body.sessions = [...body.sessions.filter((s: { name: string }) => s.name === "assistant"), ...rows.map(([name, state, parent]) => ({ ...template, name,
      identity: { ...template.identity, wolfpackSessionId: `mock:${name}`, ...(parent ? { parentSession: { wolfpackSessionId: `mock:${parent}`, wolfpackSessionName: parent } } : {}) },
      runtimeState: { ...template.runtimeState, state, inputKind: state === "needs-input" ? "question" : undefined, changedAt: at, stoppedAt: at, unseen: true, stoppedSequence: 5, acknowledgedSequence: 0 },
    }))];
    await route.fulfill({ response, json: body });
  });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json(); delete body.routines;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  await expect(block.locator(".focus-next")).not.toContainText("Unstarted");
  await expect(block.locator(".focus-next")).not.toContainText("child-finish");
  await expect(block.locator(".focus-quiet")).toContainText("api-refactor waiting on 3 sub-sessions (1 working)");
  await expect(block.locator(".focus-quiet")).toContainText("1 working");
  await expect(page.locator("#sidebar-assistant .assistant-tile-state")).toHaveText("3 next:");
  await block.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.getByRole("heading", { name: /^next / })).toHaveText("next 1 needs you · 2 done");
  await expect(view.locator(".focus-today [data-focus-start]")).toHaveCount(6);
  const quiet = view.locator(".focus-next > li").filter({ hasText: "The documentation is complete" });
  await expect(quiet).toHaveAttribute("data-kind", "done");
  await expandFocusCard(quiet);
  await expect(quiet.getByRole("textbox", { name: "reply to quiet-finish", exact: true })).toHaveAttribute("placeholder", "follow up with quiet-finish…");
  await expect(quiet.getByRole("button", { name: "mark seen", exact: true })).toBeEnabled();
});
