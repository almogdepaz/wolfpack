import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

const observedAt = new Date().toISOString();
const PEER_ORIGIN = "https://activity-peer.example.ts.net";
const PEER_INSTALLATION_ID = "6b0c31a8-f99e-4c17-b681-881c40381ef2";

const sessions = [
  {
    name: "unproven",
    lastLine: "plain terminal prompt",
    triage: "idle",
    identity: { wolfpackSessionId: "id-unproven" },
    runtimeState: { state: "needs-input", unseen: true, transitionSequence: 4 },
    activity: { freshness: "unknown", observedAt, display: "activity unavailable" },
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
    activity: { freshness: "fresh", observedAt, quietSince: observedAt, display: "" },
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
    activity: { freshness: "fresh", observedAt, lastRenderedActivityAt: observedAt, display: "" },
  },
];

const malformedPeerSession = {
  name: "malformed-activity",
  lastLine: "untrusted peer payload",
  triage: "idle",
  identity: { wolfpackSessionId: "id-malformed" },
  runtimeState: { state: "idle", unseen: true, transitionSequence: 1 },
  activity: {
    freshness: "fresh",
    observedAt: "not-a-timestamp",
    lastRenderedActivityAt: "not-a-timestamp",
    quietSince: "not-a-timestamp",
    display: "active now",
  },
};

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

test("shows rendered activity context and review changes without altering semantic status", async ({ page }) => {
  await page.goto(server.baseUrl);

  const card = (name: string) => page.getByRole("button", { name: `Open ${name}` }).locator("xpath=..");
  await expect(card("active-output").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("structured").locator(".session-activity")).toHaveText("changed since review");
  await expect(card("unproven").locator(".session-activity")).toHaveText("activity unavailable · changed since review");
});

test("omits activity from remote session responses", async ({ page }) => {
  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{
        hostname: "activity-peer.example.ts.net",
        tailnetNodeId: "n-activity-peer",
        origin: PEER_ORIGIN,
        online: true,
      }],
    }),
  }));
  await page.route(`${PEER_ORIGIN}/api/machine`, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n-activity-peer",
        installationId: PEER_INSTALLATION_ID,
        displayName: "activity peer",
        origin: PEER_ORIGIN,
      },
      wolfpack: { version: "1.7.0" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  await page.route(`${PEER_ORIGIN}/api/sessions`, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ sessions: [malformedPeerSession] }),
  }));

  await page.goto(server.baseUrl);

  const card = page.getByRole("button", { name: "Open malformed-activity" }).locator("xpath=..");
  await expect(card.locator(".session-activity")).toHaveText("changed since review");
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
