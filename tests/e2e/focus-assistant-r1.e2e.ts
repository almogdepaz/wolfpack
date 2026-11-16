import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const shots = join(homedir(), ".cache/focus-split/shots/after-r1");
async function shot(page: Page, name: string, device: string) {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}-${device}.png`), fullPage: true, animations: "disabled" });
}
async function open(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}
test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: info.project.name === "desktop" ? 900 : 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("settings hierarchy keeps chat primary and puts freshness after both states", async ({ page }, info) => {
  const desktop = info.project.name === "desktop", device = desktop ? "desktop" : "phone";
  await open(page);
  await page.locator("#assistant-content").getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-status")).toHaveText(/^on · chat: \S+ · background: .+ · updated /);
  const talk = page.locator("#assistant-setting-chat");
  const inspect = page.locator("#assistant-setting-worker");
  await expect(inspect).toHaveText("inspect background ›");
  expect(await inspect.evaluate(el => getComputedStyle(el).color)).not.toBe(await talk.evaluate(el => getComputedStyle(el).color));
  await page.locator("#settings-assistant").scrollIntoViewIfNeeded();
  await shot(page, "settings", device);
});

test("role vocabulary identifies chat and background in docked and full terminals", async ({ page }, info) => {
  const desktop = info.project.name === "desktop", device = desktop ? "desktop" : "phone";
  await open(page);
  await page.locator("#assistant-content").getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Talk to assistant", exact: true })).toHaveText("talk ›");
  await page.getByRole("button", { name: "Inspect background terminal", exact: true }).click();
  if (desktop) {
    await expect(page.locator("#assistant-pane-role")).toHaveText("background");
    await expect(page.locator("#assistant-pane canvas").first()).toBeVisible();
    await shot(page, "worker-docked", device);
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
    await page.getByRole("button", { name: "Inspect background terminal", exact: true }).click();
  } else await expect(page.locator("#chip-label")).toHaveText("background");
  await expect(page.locator("#assistant-terminal-role")).toHaveText("background");
  await shot(page, "worker-terminal", device);
  await page.locator("#assistant-terminal-focus").click();
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect(page.locator("#assistant-terminal-role")).toHaveText("chat");
  await expect(page.locator("#assistant-terminal-stop")).toHaveText("Disable assistant…");
  await shot(page, "chat-terminal", device);
});

for (const role of ["assistant", "assistant-chat"]) test(`needs-you evidence opens the correct ${role} terminal`, async ({ page }, info) => {
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(), body = await response.json();
    body.assistant.state = role === "assistant" ? "needs-input" : "done";
    body.assistant.chat.state = role === "assistant-chat" ? "needs-input" : "done";
    await route.fulfill({ response, json: body });
  });
  await open(page);
  const action = page.locator("#assistant-content").getByRole("button", { name: "assistant needs you ›", exact: true });
  await expect(action).toBeVisible();
  await shot(page, `needs-you-${role}`, info.project.name);
  await action.click();
  await expect(page.locator(info.project.name === "desktop" ? "#assistant-pane-role" : "#assistant-terminal-role")).toHaveText(role === "assistant" ? "background" : "chat");
});

test("chat not yet started is explicit in settings and cannot accept talk or plan", async ({ page }, info) => {
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(), body = await response.json();
    body.assistant.chat = { state: "starting", idle: false };
    await route.fulfill({ response, json: body });
  });
  await open(page);
  await expect(page.getByRole("button", { name: "Talk to assistant", exact: true })).toBeDisabled();
  await expect(page.locator('#assistant-content [data-focus-plan="leak"]')).toBeDisabled();
  await shot(page, "chat-starting-page", info.project.name);
  await page.locator("#assistant-content").getByRole("button", { name: "Assistant settings", exact: true }).click();
  await expect(page.locator("#assistant-setting-status")).toContainText("chat: starting · background:");
  await expect(page.getByRole("button", { name: "Talk to assistant", exact: true })).toBeDisabled();
  await shot(page, "chat-starting-settings", info.project.name);
});
