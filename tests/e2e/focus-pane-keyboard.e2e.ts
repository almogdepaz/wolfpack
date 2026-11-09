import { test, expect, type Page } from "@playwright/test";
import { CLOSE_CODE_NORMAL, WS_CLOSE_REASONS } from "../../src/ws-constants";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "desktop embedded pane"); });
const pane = (page: Page) => page.getByRole("region", { name: "Assistant terminal", exact: true });
async function openFocus(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}
async function tabToOverlay(page: Page, action: string) {
  // The header precedes both terminal input and its overlay in document order.
  // Focus is a test starting position, not an activation or pointer opt-in.
  await pane(page).getByRole("button", { name: "Back to list", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(pane(page).getByRole("button", { name: action, exact: true })).toBeFocused();
}

test("pane keyboard: Shift+Escape returns from terminal input to the list without PTY bytes", async ({ page }) => {
  const inputFrames: Buffer[] = [];
  page.on("websocket", ws => {
    if (ws.url().includes("/ws/pty")) ws.on("framesent", frame => {
      if (typeof frame.payload !== "string") inputFrames.push(Buffer.from(frame.payload));
    });
  });
  await openFocus(page);
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  await pane(page).getByRole("button", { name: "Focus terminal", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await pane(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
  // Ordinary Escape is still useful PTY input; only the advertised chord exits.
  await page.keyboard.press("Escape");
  await expect.poll(() => inputFrames.some(frame => frame.equals(Buffer.from([27])))).toBe(true);
  const before = inputFrames.length;
  await page.keyboard.press("Shift+Escape");
  await expect(page.locator(".assistant-column")).toBeFocused();
  expect(inputFrames.length).toBe(before);
  await expect(pane(page)).toHaveAccessibleDescription("Press Shift+Escape to return to the focus list.");
  await page.getByRole("textbox", { name: "Add an intention", exact: true }).pressSequentially("list only");
  expect(inputFrames.length).toBe(before);
});

for (const key of ["Enter", "Space"]) {
  test(`pane keyboard: ${key} activates Take Control without terminal opt-in`, async ({ page, context }) => {
    const owner = await context.newPage();
    let takeovers = 0, granted = 0;
    page.on("websocket", ws => {
      if (!ws.url().includes("/ws/pty")) return;
      ws.on("framesent", frame => { if (typeof frame.payload === "string" && JSON.parse(frame.payload).type === "take_control") takeovers++; });
      ws.on("framereceived", frame => { if (typeof frame.payload === "string" && JSON.parse(frame.payload).type === "control_granted") granted++; });
    });
    try {
      await openFocus(owner);
      await owner.getByRole("button", { name: "Talk to assistant", exact: true }).click();
      await expect(owner.locator("#desktop-terminal-container")).toHaveClass(/hydrated/);
      await openFocus(page);
      const overlay = pane(page).getByRole("dialog", { name: "Session active on another device", exact: true });
      await expect(overlay).toBeVisible();
      expect(takeovers).toBe(0);
      await tabToOverlay(page, "Take Control");
      await page.keyboard.press(key);
      await expect(overlay).toHaveCount(0);
      await expect.poll(() => granted).toBe(1);
      expect(takeovers).toBe(1);
      await expect(owner.locator("#desktop-conflict-overlay")).toBeVisible();
    } finally { await owner.close(); }
  });

  test(`pane keyboard: ${key} activates ended-terminal Reconnect without takeover`, async ({ page }) => {
    let end: (() => void) | undefined;
    let connections = 0, takeovers = 0;
    await page.routeWebSocket(/\/ws\/pty/, socket => {
      connections++;
      const backend = socket.connectToServer();
      socket.onMessage(message => {
        if (typeof message === "string" && JSON.parse(message).type === "take_control") takeovers++;
        backend.send(message);
      });
      backend.onMessage(message => socket.send(message));
      socket.onClose((code, reason) => backend.close({ code, reason }));
      backend.onClose((code, reason) => socket.close({ code, reason }));
      // Fault only the transport boundary; reconnect itself uses real server attach.
      end ??= () => {
        backend.close({ code: CLOSE_CODE_NORMAL, reason: WS_CLOSE_REASONS.PTY_EXITED });
        socket.close({ code: CLOSE_CODE_NORMAL, reason: WS_CLOSE_REASONS.PTY_EXITED });
      };
    });
    await openFocus(page);
    await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
    end!();
    const overlay = pane(page).getByRole("dialog", { name: "terminal ended", exact: true });
    await expect(overlay).toBeVisible();
    await tabToOverlay(page, "Reconnect");
    await page.keyboard.press(key);
    await expect(overlay).toHaveCount(0);
    await expect.poll(() => connections).toBe(2);
    await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
    expect(takeovers).toBe(0);
  });
}
