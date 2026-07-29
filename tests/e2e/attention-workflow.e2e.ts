import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

const sessions = [
  {
    name: "alpha",
    lastLine: "structured input request",
    triage: "running",
    identity: { wolfpackSessionId: "id-alpha" },
    runtimeState: { state: "needs-input", unseen: true, transitionSequence: 4 },
  },
  {
    name: "beta",
    lastLine: "structured completion",
    triage: "idle",
    identity: { wolfpackSessionId: "id-beta" },
    runtimeState: { state: "done", unseen: true, transitionSequence: 7 },
  },
  {
    name: "gamma",
    lastLine: "still running",
    triage: "running",
    identity: { wolfpackSessionId: "id-gamma" },
    runtimeState: { state: "running", unseen: false, transitionSequence: 3 },
  },
];

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sessions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions }),
  }));
});

test("typed attention is counted, marked, and filterable", async ({ page }) => {
  await page.goto(server.baseUrl);

  const filter = page.getByRole("button", { name: "Show attention sessions" });
  await expect(filter).toContainText("2");
  await expect(page.getByRole("button", { name: "Open alpha" }).locator("xpath=..")).toHaveClass(/attention-session/);
  await expect(page.getByText("unseen", { exact: true }).first()).toBeVisible();

  await filter.click();
  await expect(page.getByRole("button", { name: "Open alpha" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open beta" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open gamma" })).toBeHidden();
});

test("opening an unseen session acknowledges its exact typed transition", async ({ page }) => {
  let acknowledgement: unknown;
  await page.route("**/api/agent-runtime-state/ack", async (route) => {
    acknowledgement = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(server.baseUrl);

  await page.getByRole("button", { name: "Open alpha" }).click();
  await expect.poll(() => acknowledgement).toEqual({ sessionId: "id-alpha", transitionSequence: 4 });
});

test("bulk clear acknowledges each unseen transition without clearing typed needs-input", async ({ page }) => {
  const acknowledgements: unknown[] = [];
  await page.route("**/api/agent-runtime-state/ack", async (route) => {
    const body = route.request().postDataJSON() as { transitionSequence: number };
    acknowledgements.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runtimeState: { state: body.transitionSequence === 4 ? "needs-input" : "done", unseen: false, transitionSequence: body.transitionSequence } }),
    });
  });
  await page.goto(server.baseUrl);

  await page.getByRole("button", { name: "Clear unseen" }).click();
  await expect.poll(() => acknowledgements).toHaveLength(2);
  expect(acknowledgements).toEqual(expect.arrayContaining([
    { sessionId: "id-alpha", transitionSequence: 4 },
    { sessionId: "id-beta", transitionSequence: 7 },
  ]));
  await expect(page.getByRole("button", { name: "Show attention sessions" })).toContainText("1");
});

test("explicit clear action acknowledges unseen state without opening the session", async ({ page }) => {
  let acknowledgement: unknown;
  await page.route("**/api/agent-runtime-state/ack", async (route) => {
    acknowledgement = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runtimeState: { state: "done", unseen: false, transitionSequence: 7 } }),
    });
  });
  await page.goto(server.baseUrl);

  await page.getByRole("button", { name: "Clear attention for beta" }).click();
  await expect.poll(() => acknowledgement).toEqual({ sessionId: "id-beta", transitionSequence: 7 });
  await expect(page.getByRole("button", { name: "Show attention sessions" })).toContainText("1");
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
});
