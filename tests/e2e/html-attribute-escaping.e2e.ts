import { expect, test } from "@playwright/test";
import { esc, escAttr } from "../../src/html-escape.ts";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

const PEER_ORIGIN = "https://escaping-peer.example.ts.net";
const PEER_INSTALLATION_ID = "f9ae7025-30ad-4461-bc57-365431dbf00c";
const PEER_IDENTITY = `n-escaping-peer:${PEER_INSTALLATION_ID}`;
const PEER_NAME = 'peer" data-injected="yes & < >';
let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test("peer metadata stays within the machine-header title attribute", async ({ page }) => {
  const peerDisplayName = PEER_NAME;

  // Matches the production machineHeaderNameHtml attribute/text sink without
  // extracting that private renderer solely for this regression.
  await page.setContent(
    `<span class="machine-header-name" title="${escAttr(peerDisplayName)}">${esc(peerDisplayName)}</span>`,
  );

  const name = page.locator(".machine-header-name");
  await expect(name).toHaveText(peerDisplayName);
  await expect(name).toHaveAttribute("title", peerDisplayName);
  await expect(name).not.toHaveAttribute("data-injected");
  await expect(page.locator("[data-injected]")).toHaveCount(0);
});

test("served app bundle contains peer metadata within the machine-header title", async ({ page }) => {
  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [{
      hostname: "escaping-peer.example.ts.net",
      tailnetNodeId: "n-escaping-peer",
      origin: PEER_ORIGIN,
      online: true,
    }] }),
  }));
  await page.route(`${PEER_ORIGIN}/api/machine`, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n-escaping-peer",
        installationId: PEER_INSTALLATION_ID,
        displayName: PEER_NAME,
        origin: PEER_ORIGIN,
      },
      wolfpack: { version: "1.7.0" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ sessions: [] }),
  }));

  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Discover Tailnet" }).click();

  const name = page.locator(`.machine-group[data-machine="${PEER_IDENTITY}"] .machine-header-name`);
  await expect(name).toHaveText(PEER_NAME);
  await expect(name).toHaveAttribute("title", PEER_NAME);
  await expect(name).not.toHaveAttribute("data-injected");
  await expect(page.locator("[data-injected]")).toHaveCount(0);
});
