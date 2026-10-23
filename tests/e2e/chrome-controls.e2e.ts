import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

test("terminal chrome and accessory contain only the requested controls", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).first().click();
  await expect(page.locator("#terminal-chrome")).toHaveCount(0);
  await expect(page.locator("#terminal-stop")).toHaveCount(0);
  await expect(page.locator("#terminal-transcript-dialog")).toHaveCount(0);
  expect(await page.locator("#kb-accessory > *").evaluateAll(nodes => nodes.map(node =>
    node.getAttribute("data-key") || (node.matches("details") ? "ctrl" : node.id),
  ))).toEqual(["Enter", "Escape", "Up", "Down", "Left", "Right", "C-c", "kb-open-btn"]);
  await expect(page.getByRole('button', { name: 'Control C', exact: true, includeHidden: true })).toHaveText('^C');
  await expect(page.locator('#kb-accessory details')).toHaveCount(0);
});

test("single terminal retains global navigation and confirmed row Stop", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const width = desktop ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  const kills: unknown[] = [];
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: ["test-project", "another-project"].map(name => ({
    name, lastLine: "Single-session header fixture", identity: { wolfpackSessionId: name, agentKind: "pi" }, triage: "idle",
  })) } }));
  await page.route("**/api/kill", route => {
    kills.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== "string") return;
    const frame = JSON.parse(message);
    if (frame.type !== "attach") return;
    socket.send(JSON.stringify({ type: "attach_ack" }));
    socket.send(Buffer.from("Single-session header fixture\r\n"));
    if (frame.prefillMode === "viewport") socket.send(JSON.stringify({ type: "prefill_viewport" }));
    socket.send(JSON.stringify({ type: "prefill_done" }));
    socket.send(JSON.stringify({ type: "pty_ready" }));
  }));
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await expect(page.locator("#terminal-view")).not.toHaveClass(/swiping/);
  await expect(page.locator("#terminal-footer-session")).toHaveText("test-project");
  await expect(page.locator("#needs-input-banner")).toHaveJSProperty("hidden", true);
  await page.screenshot({ path: info.outputPath(`single-terminal-${width}.png`) });
  await expect(page.locator("#terminal-chrome")).toHaveCount(0);
  const geometry = await page.locator("#terminal-view").evaluate(view => ({
    viewTop: view.getBoundingClientRect().top,
    terminalTop: document.getElementById("desktop-terminal-container")!.getBoundingClientRect().top,
  }));
  expect(geometry.terminalTop).toBeCloseTo(geometry.viewTop, 0);
  await info.attach("terminal-top-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
  if (desktop) {
    await page.locator("#sidebar-session-list").getByRole("button", { name: "Open another-project", exact: true }).click();
  } else {
    const switcher = page.locator("#session-chip");
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(page.locator("#session-drawer")).toHaveClass(/open/);
    await page.locator('.drawer-item[data-val="another-project"]').click();
    await expect(page.locator("#chip-label")).toHaveText("another-project");
  }
  await expect(page.locator("#terminal-footer-session")).toHaveText("another-project");
  const dialog = page.getByRole("dialog", { name: "Stop session", exact: true });
  if (desktop) {
    await page.locator("#sidebar-session-list").getByRole("button", { name: "Stop another-project", exact: true }).click();
    await expect(dialog).toContainText('Stop session "another-project"?');
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(kills).toEqual([]);
    await page.locator("#sidebar-expand-btn").click();
  } else {
    await page.locator("#back-btn").click();
  }
  await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
  const stop = page.locator("#session-list").getByRole("button", { name: "Stop another-project", exact: true });
  await stop.click();
  await expect(dialog).toContainText('Stop session "another-project"?');
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(kills).toEqual([]);
  await stop.click();
  await dialog.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => kills).toEqual([{ session: "another-project" }]);
  await info.attach("essential-routes", { body: JSON.stringify({ desktop, switched: true, returnedToSessions: true, sidebarStopConfirmedThenCancelled: desktop, dashboardCancelSentNoKill: true, confirmedKills: kills }), contentType: "application/json" });
});
