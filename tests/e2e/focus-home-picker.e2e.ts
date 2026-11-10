import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
import { ASSISTANT_TIMING_DEFAULTS } from "../../src/focus-scheduler";
let server: TestServer;
const peerId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
const origin = "https://picker-peer.example.ts.net";
test.beforeEach(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterEach(async () => { await server?.close(); });
async function peer(page: Page) {
  const state = { online: true, owner: true };
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [
    { hostname: "picker-peer.example.ts.net", tailnetNodeId: "n-picker", origin, online: state.online },
    { hostname: "unverified.example.ts.net", tailnetNodeId: "n-unknown", origin: "https://unverified.example.ts.net", online: true },
  ] } }));
  const headers = { "Access-Control-Allow-Origin": "*" };
  await page.route(`${origin}/api/machine`, route => state.online ? route.fulfill({ headers, json: {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-picker", installationId: peerId, displayName: "Studio", origin },
    wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  } }) : route.abort());
  await page.route(`${origin}/api/sessions`, route => state.online ? route.fulfill({ headers, json: { sessions: [] } }) : route.abort());
  await page.route(`${origin}/api/focus**`, route => state.online ? route.fulfill({ headers, json: { home: peerId, installationId: peerId, local: state.owner, document: null, revision: 0,
    assistant: { enabled: false, folder: "/remote/assistant", state: "off", queued: 0 } } }) : route.abort());
  await page.route(`${origin}/api/settings`, route => route.fulfill({ headers, json: { settings: { assistant: ASSISTANT_TIMING_DEFAULTS } } }));
  return state;
}
async function settings(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Home machine", exact: true })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Home machine", exact: true }).locator(`option[value='${peerId}']`)).toHaveText("Studio");
}

test("home picker confirms local-only changes, refuses an enabled assistant, and cancels without writing", async ({ page }, info) => {
  await peer(page);
  await settings(page);
  const select = page.getByRole("combobox", { name: "Home machine", exact: true });
  const initial = await select.inputValue();
  if (info.project.name !== "desktop") expect(await select.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), "match the mobile form floor without input zoom").toBeGreaterThanOrEqual(16);
  const posts: string[] = [];
  page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/focus/home") posts.push(req.url()); });
  await select.selectOption(peerId);
  await expect(page.locator("#app-dialog")).toContainText("This machine will read and write focus there");
  await page.locator("#app-dialog-cancel").click();
  await expect(select).toHaveValue(initial);
  expect(posts).toEqual([]);
  await select.selectOption(peerId);
  await page.locator("#app-dialog-confirm").click();
  await expect(page.locator("#assistant-setting-error")).toContainText("Disable this machine's assistant first");
  await expect(select).toHaveValue(initial);
  expect(posts).toEqual([`${server.baseUrl}/api/focus/home`]);
  await expect(select.locator("option")).toHaveCount(2); // unverified candidate excluded
  await page.screenshot({ path: info.outputPath(`home-refused-${info.project.name}.png`), animations: "disabled" });
});

test("a saved home with a rejected owner keeps its diagnostic and can be changed back locally", async ({ page }) => {
  const state = await peer(page);
  await settings(page);
  const select = page.getByRole("combobox", { name: "Home machine", exact: true });
  const self = await select.inputValue();
  await page.locator("#assistant-setting-toggle").click();
  await page.locator("#app-dialog-confirm").click();
  await expect(page.locator("#assistant-setting-status")).toHaveText("off");
  state.owner = false;
  await select.selectOption(peerId);
  await page.locator("#app-dialog-confirm").click();
  await expect(select).toBeEnabled();
  expect(await page.locator("#assistant-setting-error").textContent()).toContain("focus home identity changed");
  await select.selectOption(self);
  await page.locator("#app-dialog-confirm").click();
  await expect.poll(async () => (await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).local).toBe(true);
});

test("home picker applies without restart, retains offline current home, and returns local with assistant off", async ({ page }, info) => {
  const state = await peer(page);
  await settings(page);
  const select = page.getByRole("combobox", { name: "Home machine", exact: true });
  const self = await select.inputValue();
  await page.locator("#assistant-setting-toggle").click();
  await page.locator("#app-dialog-confirm").click();
  await expect(page.locator("#assistant-setting-status")).toHaveText("off");
  await select.selectOption(peerId);
  await page.locator("#app-dialog-confirm").click();
  await expect(select).toHaveValue(peerId);
  await expect(page.locator("#assistant-setting-home")).toContainText("Studio");
  expect((await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).home).toBe(peerId);
  state.online = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(select.locator(`option[value='${peerId}']`)).toContainText("offline", { timeout: 15_000 });
  await expect(select.locator(`option[value='${peerId}']`)).toHaveJSProperty("disabled", true);
  await expect(select).toBeEnabled();
  for (const width of info.project.name === "desktop" ? [1440, 1280] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`home-picker-${width}.png`), animations: "disabled" });
  }
  await select.selectOption(self);
  await page.locator("#app-dialog-confirm").click();
  await expect(select).toHaveValue(self);
  await expect(page.locator("#assistant-setting-status")).toHaveText("off");
  await expect.poll(async () => (await (await page.request.get(`${server.baseUrl}/api/focus`)).json()).local).toBe(true);
});
