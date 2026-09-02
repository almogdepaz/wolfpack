import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

const sessions = [
  {
    name: "unproven",
    lastLine: "plain terminal prompt",
    triage: "idle",
    identity: { wolfpackSessionId: "id-unproven" },
    runtimeState: { state: "needs-input", unseen: true, transitionSequence: 4 },
  },
  {
    name: "structured",
    lastLine: "structured input request",
    triage: "idle",
    identity: { wolfpackSessionId: "id-structured" },
    runtimeState: {
      state: "needs-input",
      authority: "manifest",
      freshness: "fresh",
      source: "local-manifest",
      stale: false,
      unseen: true,
      transitionSequence: 7,
    },
  },
  {
    name: "active-output",
    lastLine: "new bytes",
    triage: "running",
    identity: { wolfpackSessionId: "id-output" },
    runtimeState: {
      state: "output",
      authority: "fallback",
      freshness: "fresh",
      source: "screen-fallback",
      stale: false,
      unseen: true,
      transitionSequence: 3,
    },
  },
];

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sessions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions }),
  }));
});

test("removes attention controls and unseen decoration", async ({ page }) => {
  await page.goto(server.baseUrl);

  await expect(page.locator("#sessions-attention-toolbar")).toHaveCount(0);
  await expect(page.locator(".attention-session, .unseen-marker, .attention-clear-btn")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /attention|clear unseen/i })).toHaveCount(0);
});

test("shows semantic labels only for source-backed runtime state", async ({ page }) => {
  await page.goto(server.baseUrl);

  const cardBadge = (name: string) => page
    .getByRole("button", { name: `Open ${name}` })
    .locator("xpath=..")
    .locator(".triage-badge");

  await expect(cardBadge("unproven")).toHaveText("quiet");
  await expect(cardBadge("structured")).toHaveText("needs input");
  await expect(cardBadge("active-output")).toHaveText("output");
});

test("opening a session has no unseen acknowledgement side effect", async ({ page }) => {
  const acknowledgements: unknown[] = [];
  await page.route("**/api/agent-runtime-state/ack", async (route) => {
    acknowledgements.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(server.baseUrl);

  await page.getByRole("button", { name: "Open structured" }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  expect(acknowledgements).toEqual([]);
});
