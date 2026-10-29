import { expect, test, type Page } from "@playwright/test";
import { collapseInitialSessionMenu, openProjectPickerFromUi, startTestServer, type TestServer } from "./helpers.ts";

const installationId = "2af8af29-c4fe-44f9-8a99-2a0e35952d74";
const peerIdentity = `n-peer:${installationId}`;

let server: TestServer;

// Optional display metadata must never escape to real hosts in peer fixtures.
test.beforeEach(async ({ page }) => {
  await page.route("https://**/api/info", route => route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "optional metadata unavailable" }));
  await page.route("https://**/api/events?*", route => route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "stream unavailable in this grouping fixture" }));
  await page.route("https://**/api/backend", route => route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "backend probe unavailable in this grouping fixture" }));
});

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function installMachineFixture(page: Page, withSessions = false, displayName = "verified peer", version = "test"): Promise<void> {
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [{
      hostname: "peer.example.ts.net",
      tailnetNodeId: "n-peer",
      origin: "https://peer.example.ts.net",
      online: true,
    }] }),
  }));
  await page.route("https://peer.example.ts.net/api/machine", route => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n-peer",
        installationId,
        displayName,
        origin: "https://peer.example.ts.net",
      },
      wolfpack: { version },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  await page.route("**/api/sessions", route => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ sessions: withSessions ? [{ name: "peer-session", triage: "idle" }] : [] }),
  }));
}

function mainGroup(page: Page) {
  return page.locator(`#session-list .machine-group[data-machine="${peerIdentity}"]`);
}

function sidebarGroup(page: Page) {
  return page.locator(`#sidebar-session-list .machine-group[data-machine="${peerIdentity}"]`);
}

const localInstallationId = "77d7b892-711f-4005-b62e-509d1d09a165";

for (const width of [320, 375, 390, 1280]) {
  test(`R11 duplicate CSS characterization at ${width}`, async ({ page }, info) => {
    test.skip(info.project.name !== (width === 1280 ? "desktop" : "iphone-14"), "one capture per viewport");
    await page.setViewportSize({ width, height: 900 });
    await installMachineFixture(page, true);
    await page.goto(server.baseUrl);
    const header = mainGroup(page).locator(".machine-header");
    const create = header.locator(".machine-add-btn");
    await expect(header).toHaveCSS("gap", "7px");
    await expect(create).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    // Preserve the existing interactive cascade, not just the resting border.
    if (width === 1280) {
      await create.hover();
      await expect(create).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
      await page.mouse.move(0, 0);
    }
    await create.evaluate(button => { (button as HTMLButtonElement).disabled = true; });
    await expect(create).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await create.evaluate(button => { (button as HTMLButtonElement).disabled = false; });
    await expect(create).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await info.attach("characterization", { body: JSON.stringify(await header.evaluate(element => ({
      html: element.outerHTML, gap: getComputedStyle(element).gap,
      controls: Array.from(element.querySelectorAll("button")).map(button => ({
        label: button.getAttribute("aria-label"), rect: button.getBoundingClientRect().toJSON(),
        border: getComputedStyle(button).borderColor,
      })),
    }))), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("characterization.png") });
  });
}

async function machineGeometry(page: Page, machine: string) {
  return page.evaluate(identity => {
    const list = document.querySelector<HTMLElement>("#session-list")!;
    const group = Array.from(list.querySelectorAll<HTMLElement>(".machine-group")).find(element => element.dataset.machine === identity)!;
    const scroller = (element: Element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight });
    const rect = (element: Element) => {
      const viewport = element.getBoundingClientRect().toJSON();
      return { viewport, document: { x: viewport.x + scrollX, y: viewport.y + scrollY }, listContent: { x: viewport.x - list.getBoundingClientRect().x + list.scrollLeft, y: viewport.y - list.getBoundingClientRect().y + list.scrollTop } };
    };
    return {
      window: { scrollX, scrollY, innerWidth, innerHeight }, document: scroller(document.documentElement),
      scrollingElement: document.scrollingElement ? scroller(document.scrollingElement) : null, list: scroller(list),
      header: rect(group.querySelector(".machine-header")!), create: rect(group.querySelector(".machine-add-btn")!), toggle: rect(group.querySelector(".machine-collapse-toggle")!),
      notification: { permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission, visible: document.querySelector("#notification-prompt")?.checkVisibility() ?? false },
    };
  }, machine);
}

// Keep the original900-height coverage, including scroll-clamp failures. The
// separate1600-height cases characterize unscrolled layout, not scroll stability.
for (const unscrolled of [false, true]) for (const width of [320, 375, 390]) for (const withSessions of [false, true]) for (const machine of ["", peerIdentity]) for (const update of [false, true]) {
  test(`R13 ${unscrolled ? "unscrolled " : ""}labelled mobile same-spot collapse keeps both controls fixed at ${width} (sessions ${withSessions}, ${machine ? "peer" : "local"}, update ${update})`, async ({ page }, info) => {
    test.skip(info.project.name !== "iphone-14", "synthesized touch on Chromium");
    await page.setViewportSize({ width, height: unscrolled ? 1600 : 900 });
    await installMachineFixture(page, withSessions, "peer with a long machine name", update ? "1.0.0" : "test");
    await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "local with a long machine name", version: update ? "2.0.0" : "test" } }));
    await page.goto(server.baseUrl);
    await expect(page.locator("#session-list > .machine-group[data-machine]")).toHaveCount(2);
    const group = page.locator(`#session-list .machine-group[data-machine="${machine}"]`);
    const toggle = group.locator(".machine-collapse-toggle");
    const create = group.locator(".machine-header .machine-add-btn");
    await toggle.scrollIntoViewIfNeeded();
    const before = await machineGeometry(page, machine);
    if (unscrolled) {
      expect(before.window.scrollY).toBe(0);
      expect(before.document.scrollTop).toBe(0);
      expect(before.list.scrollTop).toBe(0);
      expect(before.list.scrollHeight).toBeLessThanOrEqual(before.list.clientHeight);
    }
    const expanded = { toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! };
    expect(expanded.toggle.width).toBe(44); expect(expanded.toggle.height).toBe(44);
    expect.soft(expanded.create.width).toBeGreaterThan(100); expect(expanded.create.height).toBe(44);
    await expect(create).toHaveAttribute("aria-label", `New session on ${machine ? "peer" : "local"} with a long machine name`);
    await expect.soft(create).toHaveJSProperty("innerText", "New session");
    await expect.soft(create.locator(":scope > span")).toBeVisible();
    await expect.soft(create.locator(".machine-add-label-detail")).toBeVisible();
    await expect(create.locator("svg[aria-hidden=true] path")).toHaveAttribute("d", "M12 5v14M5 12h14");
    await expect(create).toHaveCSS("white-space", "nowrap");
    await expect.soft(create).toHaveCSS("background-color", "rgba(69, 237, 126, 0.14)");
    await expect(create).toHaveCSS("color", "rgb(69, 237, 126)");
    await expect(create).toHaveJSProperty("scrollWidth", await create.evaluate(element => element.clientWidth));
    await expect(group.locator(".machine-header-name")).toHaveAttribute("title", `${machine ? "peer" : "local"} with a long machine name`);
    if (machine && update) await expect(group.locator(".version-warning")).toBeVisible();
    if (!withSessions) {
      await expect(group.locator('[data-action="new-session"]:visible')).toHaveCount(1);
      expect(await group.innerText()).toMatch(/New session/);
    }
    await page.screenshot({ path: info.outputPath(`${machine ? "peer" : "local"}-expanded.png`) });
    const point = { x: expanded.toggle.x + 22, y: expanded.toggle.y + 22 };
    await page.touchscreen.tap(point.x, point.y);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator(".machine-group-body")).toHaveAttribute("hidden", "");
    await expect(group.locator(".machine-group-body")).toHaveAttribute("inert", "");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-machine-group-preferences")!).collapsed.main)).toEqual([machine || "local"]);
    const collapsed = { toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! };
    const after = await machineGeometry(page, machine);
    await info.attach(`${machine ? "peer" : "local"}-geometry`, { body: JSON.stringify({ width, withSessions, update, unscrolled, expanded, collapsed, point, before, after }), contentType: "application/json" });
    if (unscrolled) {
      expect(after.window.scrollY).toBe(0);
      expect(after.document.scrollTop).toBe(0);
      expect(after.list.scrollTop).toBe(0);
    }
    await page.screenshot({ path: info.outputPath(`${machine ? "peer" : "local"}-collapsed.png`) });
    expect.soft(collapsed).toEqual(expanded);
    await expect(create).toHaveJSProperty("innerText", "New session");
    await expect(create.locator(".machine-add-label-detail")).toBeVisible();
    // Do not re-target by locator: the exact second tap must expand, not New.
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.locator("#projects-view")).not.toHaveClass(/visible/);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(group.locator(".machine-group-body")).not.toHaveAttribute("hidden", "");
    await expect(group.locator(".machine-header")).toHaveJSProperty("scrollWidth", await group.locator(".machine-header").evaluate(element => element.clientWidth));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-machine-group-preferences")!).collapsed.main)).toEqual([]);
  });
}

for (const width of [320, 375, 390]) test(`R13 saved session order retains Reset, UPDATE and fixed labelled controls at ${width}`, async ({ page }, info) => {
  test.skip(info.project.name !== "iphone-14", "narrow touch header with saved order");
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(machine => localStorage.setItem("wolfpack-session-order", JSON.stringify({ version: 1, sessions: [{ machineUrl: machine, sessionId: "peer-session" }] })), peerIdentity);
  await installMachineFixture(page, true, "peer with a long machine name", "1.0.0");
  await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "local machine", version: "2.0.0" } }));
  await page.goto(server.baseUrl);
  const group = mainGroup(page);
  const header = group.locator(".machine-header");
  const reset = header.getByRole("button", { name: "Reset session order", exact: true });
  await expect(reset).toBeVisible();
  await expect(header.locator(".version-warning")).toBeVisible();
  expect.soft((await header.locator(".machine-header-name").boundingBox())!.width).toBeGreaterThan(0);
  const toggle = header.locator(".machine-collapse-toggle");
  const create = header.locator(".machine-add-btn");
  const expanded = { toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! };
  await page.touchscreen.tap(expanded.toggle.x + 22, expanded.toggle.y + 22);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect.soft({ toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! }).toEqual(expanded);
  await page.touchscreen.tap(expanded.toggle.x + 22, expanded.toggle.y + 22);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#projects-view")).not.toHaveClass(/visible/);
  await expect.poll(() => header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await reset.click();
  await expect(reset).toHaveCount(0);
});

for (const width of [320, 375, 390]) {
  test(`R11 UPDATE badge stays readable without moving controls at ${width}`, async ({ page }, info) => {
    test.skip(info.project.name !== "iphone-14", "one Chromium touch capture per width");
    await page.setViewportSize({ width, height: 900 });
    await installMachineFixture(page, true, "peer with a long machine name", "1.0.0");
    await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "newer local machine", version: "2.0.0" } }));
    await page.goto(server.baseUrl);
    const header = mainGroup(page).locator(".machine-header");
    const badge = header.locator(".version-warning");
    await expect(badge).toBeVisible();
    const name = (await header.locator(".machine-header-name").boundingBox())!;
    const lines = await badge.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return Array.from(range.getClientRects()).map(rect => rect.toJSON());
    });
    await info.attach("badge-geometry", { body: JSON.stringify({ name, lines }), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("update-badge-expanded.png") });
    expect.soft(lines).toHaveLength(1);
    expect.soft(name.width).toBeGreaterThan(0); // names may ellipsize to retain the full action and UPDATE
    const toggle = header.locator(".machine-collapse-toggle");
    const create = header.locator(".machine-add-btn");
    const expanded = { toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! };
    expect(expanded.toggle.width).toBe(44); expect(expanded.create.width).toBeGreaterThan(100);
    await expect(header).toHaveJSProperty("scrollWidth", await header.evaluate(element => element.clientWidth));
    await page.touchscreen.tap(expanded.toggle.x + 22, expanded.toggle.y + 22);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect({ toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! }).toEqual(expanded);
    await page.screenshot({ path: info.outputPath("update-badge-collapsed.png") });
    await page.touchscreen.tap(expanded.toggle.x + 22, expanded.toggle.y + 22);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#projects-view")).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

for (const machine of ["", peerIdentity]) {
  test(`R11 empty machine has one create action and preserves scoped creation (${machine ? "peer" : "local"})`, async ({ page }, info) => {
    await installMachineFixture(page);
    await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "local machine", version: "test" } }));
    const origin = machine ? "https://peer.example.ts.net" : server.baseUrl;
    const name = machine ? "verified peer" : "local machine";
    const headers = { "Access-Control-Allow-Origin": "*" };
    const requests: Array<{ url: string; body: unknown }> = [];
    await page.route("**/api/projects", route => route.fulfill({ headers, json: { projects: ["r11-project"] } }));
    await page.route("**/api/settings", route => route.fulfill({ headers, json: { effective: { cmds: ["shell"], agentCmd: "shell" } } }));
    await page.route("**/api/next-session-name**", route => route.fulfill({ headers, json: { name: "r11-new" } }));
    await page.route("**/api/create", route => {
      requests.push({ url: route.request().url(), body: route.request().postDataJSON() });
      return route.fulfill({ headers, json: { ok: true, session: "r11-new" } });
    });
    await page.goto(server.baseUrl);
    const group = page.locator(`#session-list .machine-group[data-machine="${machine}"]`);
    const headerCreate = group.locator(".machine-header .machine-add-btn");
    const zeroCreate = group.locator(".zero-session-primary");
    const desktop = info.project.name === "desktop";
    await expect(group.locator(".zero-session-card")).toBeVisible();
    await expect(group.getByRole("heading", { name: "No sessions yet", exact: true })).toBeVisible();
    await expect(group.getByRole("list", { name: "Session creation steps" }).locator("li")).toHaveCount(3);
    await expect(group.getByRole("link", { name: "First session guide", exact: true })).toBeVisible();
    await expect.soft(group.locator('[data-action="new-session"]:visible')).toHaveCount(1);
    await expect.soft(zeroCreate).toBeVisible({ visible: desktop });
    await expect(headerCreate).toHaveCount(desktop ? 0 : 1);
    if (!desktop) {
      await expect(page.locator(".new-session-primary")).toBeHidden();
      expect(await zeroCreate.evaluate(element => {
        (element as HTMLElement).focus();
        return document.activeElement === element;
      })).toBe(false);
    }
    const create = desktop ? zeroCreate : headerCreate;
    await page.screenshot({ path: info.outputPath("empty-machine.png") });
    await create.click();
    await expect(page.locator("#create-project-action")).toHaveAttribute("aria-label", `Create project on ${name}`);
    await page.getByRole("button", { name: "Open project r11-project", exact: true }).click();
    if (!desktop) {
      await page.locator("#back-btn").click();
      await page.locator("#back-btn").click();
      await expect(create).toBeFocused();
      await expect(group.locator(".machine-collapse-toggle")).toHaveAttribute("aria-expanded", "true");
      await create.click();
      await page.getByRole("button", { name: "Open project r11-project", exact: true }).click();
    }
    await page.getByRole("button", { name: "Start shell", exact: true }).click();
    await expect.poll(() => requests).toEqual([{ url: `${origin}/api/create`, body: { project: "r11-project", cmd: "shell", sessionName: "r11-new" } }]);
    await info.attach("scoped-create", { body: JSON.stringify(requests), contentType: "application/json" });
  });
}

for (const withSessions of [false, true]) for (const collapsed of [false, true]) for (const machine of ["", peerIdentity]) {
  test(`R13 scoped create helper opens actual desktop action (sessions ${withSessions}, collapsed ${collapsed}, ${machine ? "peer" : "local"})`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop header omission policy");
    await installMachineFixture(page, withSessions);
    await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "local machine", version: "test" } }));
    await page.route("**/api/projects", route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { projects: [] } }));
    await page.goto(server.baseUrl);
    const group = page.locator(`#session-list .machine-group[data-machine="${machine}"]`);
    if (collapsed) await group.locator(".machine-collapse-toggle").click();
    await expect(group.locator(".machine-header .machine-add-btn")).toHaveCount(!collapsed && withSessions ? 1 : 0);
    await openProjectPickerFromUi(page, machine);
    await expect(page.locator("#create-project-action")).toHaveAttribute("aria-label", `Create project on ${machine ? "verified peer" : "local machine"}`);
    await page.keyboard.press("Escape");
    await expect(group.locator(".machine-collapse-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(group.locator(withSessions ? ".machine-add-btn" : ".zero-session-primary")).toBeVisible();
  });
}

test("R13 machine create keeps focus, disabled and hover feedback", async ({ page }, info) => {
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);
  const create = mainGroup(page).getByRole("button", { name: "New session on verified peer", exact: true });
  const resting = await create.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
  await create.focus();
  await expect(create).toBeFocused();
  await expect(create).toHaveCSS("outline-style", "solid");
  await expect(create).toHaveCSS("outline-width", "2px");
  await expect(create).toHaveCSS("outline-color", "rgb(69, 237, 126)");
  await create.evaluate(element => { (element as HTMLButtonElement).disabled = true; });
  await expect(create).toBeDisabled();
  await expect(create).toHaveCSS("cursor", "not-allowed");
  await expect(create).not.toHaveCSS("background-color", resting.background);
  await expect(create).not.toHaveCSS("color", resting.color);
  await create.evaluate(element => { (element as HTMLButtonElement).disabled = false; });
  await expect(create).toBeEnabled();
  await expect(create).toHaveCSS("background-color", resting.background);
  if (info.project.name === "desktop") {
    await create.hover();
    await expect(create).toHaveCSS("background-color", "rgba(69, 237, 126, 0.16)");
    await page.mouse.down();
    await expect(create).toHaveCSS("border-top-color", "rgb(69, 237, 126)");
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
});

test("R13 removes the desktop global New DOM, retaining scoped machine actions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop dashboard removal");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-dashboard-controls .new-session-primary")).toHaveCount(0);
  await expect(mainGroup(page).getByRole("button", { name: "New session on verified peer", exact: true })).toBeVisible();
  await expect(page.locator("#session-summary")).toBeVisible();
  await expect(page.locator("#dashboard-session-filter")).toBeVisible();
  await page.screenshot({ path: info.outputPath("desktop-scoped-new.png") });
});

for (const { hostname, localName, peerName } of [
  { hostname: "oldsgt", localName: "Almog’s MacBook Pro", peerName: "sgt" },
  { hostname: "Mac", localName: "sgt", peerName: "Almog’s MacBook Pro" },
]) test(`local and remote render server-owned names when opened on ${hostname}`, async ({ page }, testInfo) => {
  await installMachineFixture(page, true, peerName);
  let infoRequests = 0;
  await page.route(`${server.baseUrl}/api/info`, route => {
    infoRequests++;
    return route.fulfill({ json: { name: localName, version: "test", machineId: localInstallationId } });
  });
  let machineRequests = 0;
  await page.route(`${server.baseUrl}/api/machine`, route => {
    machineRequests++;
    return route.fulfill({ json: { machine: { installationId: localInstallationId, displayName: localName, origin: "https://not-a-routing-authority.example.ts.net" }, wolfpack: { version: "not-version-authority" } } });
  });
  await page.goto(server.baseUrl);
  const local = page.locator('.machine-group[data-machine=""]').filter({ visible: true });
  await collapseInitialSessionMenu(page);
  const peer = testInfo.project.name === "desktop" ? sidebarGroup(page) : mainGroup(page);
  await expect(local.locator(".machine-header-name")).toHaveText(localName);
  await expect(local.locator(".machine-header-name")).toHaveAttribute("title", localName);
  await expect(peer.locator(".machine-header-name")).toHaveText(peerName);
  await expect(local.getByRole("button", { name: "Open peer-session", exact: true })).toHaveAttribute("data-machine", "");
  await expect(peer.getByRole("button", { name: "Open peer-session", exact: true })).toHaveAttribute("data-machine", peerIdentity);
  await local.getByRole("button", { name: `Collapse ${localName}`, exact: true }).click();
  await expect(local.getByRole("button", { name: `Expand ${localName}`, exact: true })).toHaveAttribute("aria-expanded", "false");
  await local.getByRole("button", { name: `Expand ${localName}`, exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("advertised-names.png") });
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Expand sessions", exact: true }).click();
    await expect(page.locator('#session-list .machine-group[data-machine=""] .machine-header-name')).toHaveText(localName);
  }
  expect(infoRequests).toBe(1);
  expect(machineRequests).toBe(0);
});

test("local server name stays usable without a Tailnet handshake lookup", async ({ page }) => {
  await installMachineFixture(page, true);
  await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "hostname-fallback", version: "test", machineId: localInstallationId } }));
  let machineRequests = 0;
  await page.route(`${server.baseUrl}/api/machine`, route => {
    machineRequests++;
    return route.fulfill({ status: 503, json: { error: "tailnet unavailable" } });
  });
  await page.goto(server.baseUrl);
  const local = page.locator('.machine-group[data-machine=""]').filter({ visible: true });
  await expect(local.locator(".machine-header-name")).toHaveText("hostname-fallback");
  await expect(local.getByRole("button", { name: "Open peer-session", exact: true })).toHaveAttribute("data-machine", "");
  await expect(page.locator("#settings-version")).toHaveText("wolfpack vtest");
  expect(machineRequests).toBe(0);
});

for (const { localName, peerName } of [
  { localName: "Mac", peerName: "Almog’s MacBook Pro" },
  { localName: "oldsgt", peerName: "sgt" },
]) test(`legacy local metadata keeps ${localName} and advertised peer ${peerName}`, async ({ page }, testInfo) => {
  await installMachineFixture(page, true, peerName);
  await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: localName, version: "test" }) }));
  let infoRequests = 0;
  await page.route("https://peer.example.ts.net/api/info", route => {
    infoRequests++;
    return route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ name: "peer-MacBook-Pro", machineId: installationId, version: "not-routing-authority" }) });
  });
  await page.goto(server.baseUrl);
  await collapseInitialSessionMenu(page);
  const group = testInfo.project.name === "desktop" ? sidebarGroup(page) : mainGroup(page);
  await expect(group.locator(".machine-header-name")).toHaveText(peerName);
  await expect(group.locator(".machine-header-name")).toHaveAttribute("title", peerName);
  await expect(page.locator('.machine-group[data-machine=""] .machine-header-name').filter({ visible: true })).toHaveText(localName);
  await expect(group).toHaveAttribute("data-machine", peerIdentity);
  await expect(group.getByRole("button", { name: "Open peer-session", exact: true })).toHaveAttribute("data-machine", peerIdentity);
  await group.getByRole("button", { name: `Collapse ${peerName}`, exact: true }).click();
  await expect(group.getByRole("button", { name: `Expand ${peerName}`, exact: true })).toHaveAttribute("aria-expanded", "false");
  await group.getByRole("button", { name: `Expand ${peerName}`, exact: true }).click();
  if (testInfo.project.name === "desktop") {
    await page.screenshot({ path: testInfo.outputPath("full-machine-name-sidebar.png") });
    await page.getByRole("button", { name: "Expand sessions", exact: true }).click();
    await expect(mainGroup(page).locator(".machine-header-name")).toHaveText(peerName);
  }
  expect(infoRequests).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("full-machine-name.png") });
});

test("unmatched display metadata leaves the verified peer label and sessions usable", async ({ page }, testInfo) => {
  await installMachineFixture(page, true);
  await page.route("https://peer.example.ts.net/api/info", route => route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ name: "wrong-installation-MacBook", machineId: "00000000-0000-4000-8000-000000000000" }) }));
  await page.goto(server.baseUrl);
  await collapseInitialSessionMenu(page);
  const group = testInfo.project.name === "desktop" ? sidebarGroup(page) : mainGroup(page);
  await expect(group.locator(".machine-header-name")).toHaveText("verified peer");
  await expect(group.getByRole("button", { name: "Open peer-session", exact: true })).toBeVisible();
  await expect(group.getByRole("button", { name: "Open peer-session", exact: true })).toHaveAttribute("data-machine", peerIdentity);
});

test("compact machine headers make the name the drag handle and reserve the chevron for collapse", async ({ page }, testInfo) => {
  await installMachineFixture(page);
  await page.goto(server.baseUrl);

  const group = mainGroup(page);
  const name = group.locator(".machine-name-handle");
  const toggle = group.getByRole("button", { name: "Collapse verified peer" });
  await expect(name).toHaveAttribute("title", "Drag to reorder verified peer");
  await expect(name.locator(".machine-header-name")).toHaveText("verified peer");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("");
  await expect(toggle.locator(":scope > .machine-collapse-chevron")).toBeVisible();
  await expect(toggle.locator(".machine-header-name")).toHaveCount(0);
  await expect(group.locator(".machine-order-options, [data-machine-menu-offset]")).toHaveCount(0);

  await toggle.click();
  await expect(group.getByRole("button", { name: "Expand verified peer" })).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".machine-group-body")).toHaveAttribute("hidden", "");
  await expect(group.locator(".machine-group-body")).toHaveAttribute("inert", "");
  await expect(group.locator(".machine-header-btns")).toHaveCount(0);
  await expect(group.locator(".machine-header").getByRole("button")).toHaveCount(testInfo.project.name === "desktop" ? 1 : 2);
  await expect(group.getByRole("button", { name: "New session on verified peer" })).toHaveCount(testInfo.project.name === "desktop" ? 0 : 1);
});

for (const withSessions of [false, true]) for (const collapsed of [false, true]) {
  test(`mobile peer header creation preserves machine binding and collapse (sessions ${withSessions}, collapsed ${collapsed})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop', 'mobile per-machine action');
    const name = 'verified "peer" & <box>';
    await installMachineFixture(page, withSessions, name);
    const requests: string[] = [];
    const headers = { 'Access-Control-Allow-Origin': '*' };
    await page.route('https://peer.example.ts.net/api/projects', route => {
      requests.push(route.request().url());
      return route.fulfill({ headers, json: { projects: ['peer-project'] } });
    });
    await page.route('https://peer.example.ts.net/api/settings', route => route.fulfill({ headers, json: { effective: { cmds: ['shell'], agentCmd: 'shell' } } }));
    await page.route('https://peer.example.ts.net/api/next-session-name**', route => route.fulfill({ headers, json: { name: 'peer-new' } }));
    await page.goto(server.baseUrl);
    const group = mainGroup(page);
    if (collapsed) await group.getByRole('button', { name: `Collapse ${name}`, exact: true }).click();
    const create = group.locator('.machine-header').getByRole('button', { name: `New session on ${name}`, exact: true });
    await expect(create).toHaveCount(1);
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('data-machine', peerIdentity);
    await expect(page.locator('.new-session-primary')).toBeHidden();
    await page.evaluate(() => window.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('.machine-add-btn')) document.documentElement.dataset.newClickBubbled = 'yes';
    }));
    await create.click();
    await expect(page.locator('html')).not.toHaveAttribute('data-new-click-bubbled', 'yes');
    await expect(page.locator('#create-project-action')).toHaveAttribute('aria-label', `Create project on ${name}`);
    await page.getByRole('button', { name: 'Open project peer-project', exact: true }).click();
    await expect(page.locator('#session-name-input')).toHaveValue('peer-new');
    await expect(page.getByRole('button', { name: 'Start shell', exact: true })).toBeVisible();
    await page.locator('#back-btn').click();
    await page.locator('#back-btn').click();
    await expect(create).toBeFocused();
    await expect(group.locator('.machine-collapse-toggle')).toHaveAttribute('aria-expanded', String(!collapsed));
    expect(requests).toEqual(['https://peer.example.ts.net/api/projects']);
    await testInfo.attach('peer-creation-flow', { body: JSON.stringify({ withSessions, collapsed, machine: peerIdentity, requests, name }), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('peer-create-return.png') });
  });
}

test("empty sidebar machine groups keep a header create action on their own machine", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar creation regression");
  await installMachineFixture(page);
  await page.route("**/api/sessions", route => {
    const local = new URL(route.request().url()).origin !== "https://peer.example.ts.net";
    return route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: local ? [{ name: "local-session", triage: "idle" }] : [] }),
    });
  });
  const projectRequests: string[] = [];
  await page.route("https://peer.example.ts.net/api/projects", route => {
    projectRequests.push(route.request().url());
    return route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ projects: [] }),
    });
  });
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const group = sidebarGroup(page);
  const expandedCreate = group.getByRole("button", { name: "New session on verified peer" });
  await expect(expandedCreate).toBeVisible();
  await expandedCreate.click();
  await expect(page.locator("#create-project-action")).toHaveAttribute("aria-label", "Create project on verified peer");

  await page.goto(server.baseUrl);
  await collapseInitialSessionMenu(page);
  const reloadedGroup = sidebarGroup(page);
  await reloadedGroup.getByRole("button", { name: "Collapse verified peer" }).click();
  await expect(reloadedGroup.getByRole("button", { name: "New session on verified peer" })).toHaveCount(0);
  await reloadedGroup.getByRole("button", { name: "Expand verified peer" }).click();
  await reloadedGroup.getByRole("button", { name: "New session on verified peer" }).click();
  await expect(page.locator("#create-project-action")).toHaveAttribute("aria-label", "Create project on verified peer");
  expect(projectRequests).toEqual([
    "https://peer.example.ts.net/api/projects",
    "https://peer.example.ts.net/api/projects",
  ]);
});

test("machine collapse controls retain valid hidden bodies on both desktop surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop owns both machine presentation surfaces");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const assertCollapseRelationship = async (group: ReturnType<typeof mainGroup>) => {
    const toggle = group.getByRole("button", { name: "Collapse verified peer" });
    const bodyId = await toggle.getAttribute("aria-controls");
    expect(bodyId).not.toBeNull();
    const body = page.locator(`[id="${bodyId}"]`);
    await expect(body).toHaveCount(1);
    await expect(body).not.toHaveAttribute("hidden", "");
    await toggle.click();
    const expandToggle = group.getByRole("button", { name: "Expand verified peer" });
    await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    await expect(expandToggle).toBeFocused();
    await expect(body).toHaveCount(1);
    await expect(body).toHaveAttribute("hidden", "");
    await expect(body).toHaveAttribute("inert", "");
    const cardOpen = body.locator('[data-action="open-session"][data-session="peer-session"]');
    await expect(cardOpen).toBeHidden();
    expect(await cardOpen.evaluate(element => {
      (element as HTMLElement).focus();
      return document.activeElement === element;
    })).toBe(false);
    await expandToggle.click();
    const restoredToggle = group.getByRole("button", { name: "Collapse verified peer" });
    await expect(restoredToggle).toHaveAttribute("aria-expanded", "true");
    await expect(restoredToggle).toBeFocused();
    await expect(body).not.toHaveAttribute("hidden", "");
    await expect(body).not.toHaveAttribute("inert", "");
  };

  await assertCollapseRelationship(sidebarGroup(page));
  await page.getByRole("button", { name: "Expand sessions" }).click();
  await assertCollapseRelationship(mainGroup(page));
});

test("expanded desktop machine rows share a contiguous grouped surface", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "expanded desktop layout regression");
  await installMachineFixture(page, true);
  await page.route("**/api/sessions", route => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ sessions: [
      { name: "first-peer-session", triage: "idle" },
      { name: "second-peer-session", triage: "idle" },
    ] }),
  }));
  await page.goto(server.baseUrl);

  const cards = mainGroup(page).locator(".card");
  await expect(cards).toHaveCount(2);
  const firstBox = await cards.nth(0).boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(Math.abs(secondBox!.y - (firstBox!.y + firstBox!.height))).toBeLessThanOrEqual(1);
});

test("machine drag order is shared while main and sidebar collapse remain independent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop owns both machine presentation surfaces");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);
  await collapseInitialSessionMenu(page);

  const peerHandle = sidebarGroup(page).locator(".machine-name-handle");
  const localGroup = page.locator('#sidebar-session-list .machine-group[data-machine=""]');
  await peerHandle.hover();
  await page.mouse.down();
  await localGroup.locator(".machine-header").hover();
  await page.mouse.up();
  await expect.poll(() => page.locator("#sidebar-session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);

  await page.getByRole("button", { name: "Expand sessions" }).click();
  await mainGroup(page).getByRole("button", { name: "Collapse verified peer" }).click();
  await page.getByRole("button", { name: "Collapse sessions" }).click();

  await expect(sidebarGroup(page).getByRole("button", { name: "Collapse verified peer" })).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.locator("#sidebar-session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-machine-group-preferences") ?? "null")))
    .toEqual({
      version: 1,
      order: [peerIdentity, "local"],
      collapsed: { main: [peerIdentity], sidebar: [] },
    });

  await page.reload();
  await collapseInitialSessionMenu(page);
  await expect.poll(() => page.locator("#sidebar-session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  await expect(sidebarGroup(page).getByRole("button", { name: "Collapse verified peer" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Expand sessions" }).click();
  await expect(mainGroup(page).getByRole("button", { name: "Expand verified peer" })).toHaveAttribute("aria-expanded", "false");
});

test("machine headers expose drag-only reordering", async ({ page }, testInfo) => {
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  const group = mainGroup(page);
  await expect(group.locator(".machine-name-handle")).toHaveCount(1);
  await expect(group.locator(".machine-order-options, [data-machine-menu-offset]")).toHaveCount(0);
  await expect(group.getByRole("button", { name: /Move verified peer (up|down)/ })).toHaveCount(0);
});

test("all-collapsed sidebar groups retain chooser ownership and toggle focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar ownership regression");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const groups = page.locator("#sidebar-session-list > .machine-group");
  await expect(groups).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    const group = groups.nth(index);
    await group.locator(".machine-collapse-toggle").click();
    const toggle = group.locator('.machine-collapse-toggle[aria-expanded="false"]');
    await expect(toggle).toBeFocused();
    await expect(group.locator(".machine-group-body")).toHaveAttribute("hidden", "");
  }
  await expect(groups).toHaveCount(2);
  await expect(page.locator("#session-list")).toHaveAttribute("hidden", "");
});

test("single-machine sidebar retains its collapsed group and toggle focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar ownership regression");
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [] }),
  }));
  await page.route("**/api/sessions", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: [{ name: "local-session", triage: "idle" }] }),
  }));
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const group = page.locator('#sidebar-session-list > .machine-group[data-machine=""]');
  await expect(group).toHaveCount(1);
  await group.locator(".machine-collapse-toggle").click();
  const toggle = group.locator('.machine-collapse-toggle[aria-expanded="false"]');
  await expect(toggle).toBeFocused();
  await expect(group.locator(".machine-group-body")).toHaveAttribute("hidden", "");
  await expect(page.locator("#session-list")).toHaveAttribute("hidden", "");
});

test("native wheel scrolling remains available outside machine reorder handles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "native wheel evidence is collected on desktop Chromium");
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [] }),
  }));
  await page.route("**/api/sessions", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: Array.from({ length: 24 }, (_, index) => ({ name: `session-${index}`, triage: "idle" })) }),
  }));
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const list = page.locator("#sidebar-session-list");
  await expect(list.locator(".card")).toHaveCount(24);
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test("native touch preserves pre-hold name scrolling and commits a held machine reorder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-se", "native Chromium touch arbitration regression");
  await installMachineFixture(page, true);
  let peerSessionCount = 24;
  await page.route("**/api/sessions", route => {
    const remote = new URL(route.request().url()).origin === "https://peer.example.ts.net";
    const sessions = remote
      ? Array.from({ length: peerSessionCount }, (_, index) => ({ name: `peer-session-${index}`, triage: "idle" }))
      : [{ name: "local-session", triage: "idle" }];
    return route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions }),
    });
  });
  await page.goto(server.baseUrl);

  const touch = await page.context().newCDPSession(page);
  const peerName = mainGroup(page).locator(".machine-name-handle");
  const scrollBox = await peerName.boundingBox();
  expect(scrollBox).not.toBeNull();
  const x = scrollBox!.x + scrollBox!.width / 2;
  const y = scrollBox!.y + scrollBox!.height / 2;
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y: y - 120, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.locator("#session-list").evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  peerSessionCount = 1;
  await page.goto(server.baseUrl);
  const localName = page.locator('#session-list .machine-group[data-machine=""] .machine-name-handle');
  await expect(localName).toBeVisible();
  await expect(peerName).toBeVisible();
  const localBox = await localName.boundingBox();
  const reorderBox = await peerName.boundingBox();
  expect(localBox).not.toBeNull();
  expect(reorderBox).not.toBeNull();
  const reorderX = reorderBox!.x + reorderBox!.width / 2;
  const reorderY = reorderBox!.y + reorderBox!.height / 2;
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: reorderX, y: reorderY, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  await page.waitForTimeout(350);
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: localBox!.x + localBox!.width / 2, y: localBox!.y + localBox!.height / 2, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
});

test("revoked ordered peer is never rendered as the local machine", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "main and sidebar local routing regression");
  let candidateMode: "ready" | "revoked" = "ready";
  let holdPostRevocationLocalRefresh = false;
  let postRevocationLocalRequests = 0;
  let releasePostRevocationLocalRequests: () => void = () => {};
  const postRevocationLocalRequestsReleased = new Promise<void>((resolve) => { releasePostRevocationLocalRequests = resolve; });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(candidateMode === "ready"
      ? { candidates: [{ hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true }] }
      : { candidates: [] }),
  }));
  await page.route("https://peer.example.ts.net/api/machine", route => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: { tailnetNodeId: "n-peer", installationId, displayName: "verified peer", origin: "https://peer.example.ts.net" },
      wolfpack: { version: "test" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  await page.route("**/api/sessions", async route => {
    const local = new URL(route.request().url()).origin !== "https://peer.example.ts.net";
    if (local && holdPostRevocationLocalRefresh) {
      postRevocationLocalRequests++;
      await postRevocationLocalRequestsReleased;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        sessions: local ? [{ name: "local-session", triage: "idle" }] : [{ name: "peer-session", triage: "idle" }],
      }),
    });
  });

  await page.goto(server.baseUrl);
  await collapseInitialSessionMenu(page);
  await expect(sidebarGroup(page).getByRole("button", { name: "Open peer-session" })).toBeVisible();
  const peerHandle = sidebarGroup(page).locator(".machine-name-handle");
  await peerHandle.hover();
  await page.mouse.down();
  const peerHandleBox = await peerHandle.boundingBox();
  expect(peerHandleBox).not.toBeNull();
  await page.mouse.move(peerHandleBox!.x + 12, peerHandleBox!.y + 20, { steps: 2 });
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();

  candidateMode = "revoked";
  holdPostRevocationLocalRefresh = true;
  await page.evaluate(() => document.getElementById("sidebar-settings-btn")?.click());
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await page.evaluate(() => document.querySelector<HTMLElement>(".discover-btn")?.click());
  await expect(sidebarGroup(page)).toHaveClass(/offline/);
  // Discovery no longer restarts unrelated local captures. Explicit resume
  // creates the pending local read needed for this projection-fence regression.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => postRevocationLocalRequests).toBeGreaterThan(0);
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await page.mouse.up();
  const assertCanonicalLocalProjection = async (surface: "#session-list" | "#sidebar-session-list") => {
    const groups = page.locator(`${surface} > .machine-group`);
    await expect(groups).toHaveCount(2);
    const local = page.locator(`${surface} > .machine-group[data-machine=""]`);
    const stalePeer = page.locator(`${surface} > .machine-group[data-machine="${peerIdentity}"]`);
    await expect(stalePeer).toHaveClass(/offline/);
    await expect(stalePeer.locator('[data-action="new-session"]')).toBeDisabled();
    await expect(stalePeer.locator('[data-action="open-session"], [data-action="kill-session"], [data-action="toggle-grid"]')).toHaveCount(0);
    await expect(local).toContainText("local-session");
    await expect(local).not.toContainText("verified peer");
    await expect(local).not.toContainText("peer-session");
    const actionMachines = await local.locator('[data-action="new-session"], [data-action="open-session"], [data-action="kill-session"], [data-action="toggle-grid"]')
      .evaluateAll(actions => actions.map(action => (action as HTMLElement).dataset.machine ?? ""));
    expect(actionMachines.length).toBeGreaterThan(0);
    expect(actionMachines).toEqual(actionMachines.map(() => ""));
  };
  try {
    await page.locator("#settings-back-btn").click();
    await page.getByRole("button", { name: "Idle sessions" }).click();
    await page.getByRole("button", { name: "Idle sessions" }).click();
    await page.evaluate(() => {
      const expand = document.getElementById("sidebar-expand-btn");
      if (!expand?.classList.contains("active")) expand?.click();
    });
    await expect(page.locator("#session-list")).not.toHaveAttribute("hidden", "");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => postRevocationLocalRequests).toBeGreaterThanOrEqual(2);
    await assertCanonicalLocalProjection("#session-list");
    await page.evaluate(() => {
      const expand = document.getElementById("sidebar-expand-btn");
      if (expand?.classList.contains("active")) expand.click();
    });
    await assertCanonicalLocalProjection("#sidebar-session-list");
  } finally {
    releasePostRevocationLocalRequests();
  }
  await expect(page.locator("#sidebar-session-list").getByRole("button", { name: "Open local-session" })).toBeVisible();
  await assertCanonicalLocalProjection("#sidebar-session-list");
  await page.evaluate(() => {
    const expand = document.getElementById("sidebar-expand-btn");
    if (!expand?.classList.contains("active")) expand?.click();
  });
  await expect(page.locator("#session-list")).not.toHaveAttribute("hidden", "");
  await assertCanonicalLocalProjection("#session-list");
});

test("outside machine drop cancels a previously valid preview", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop pointer drop regression");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  const peerHandle = mainGroup(page).locator(".machine-name-handle");
  const localGroup = page.locator('#session-list .machine-group[data-machine=""]');
  await expect(localGroup).toBeVisible();
  const localBox = await localGroup.boundingBox();
  expect(localBox).not.toBeNull();
  await peerHandle.hover();
  await page.mouse.down();
  await page.mouse.move(localBox!.x + localBox!.width / 2, localBox!.y + 8, { steps: 6 });
  await expect(page.locator(".machine-group-order-placeholder")).toBeVisible();
  await page.mouse.move(-20, -20, { steps: 2 });
  await page.mouse.up();

  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual(["", peerIdentity]);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-machine-group-preferences"))).toBeNull();
});

test("sidebar chooser teardown cancels an active machine drag safely", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar lifecycle regression");
  await installMachineFixture(page, true);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const handle = sidebarGroup(page).locator(".machine-name-handle");
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move((await handle.boundingBox())!.x + 12, (await handle.boundingBox())!.y + 20, { steps: 2 });
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await page.evaluate(() => document.getElementById("sidebar-expand-btn")?.click());
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("#sidebar-session-list .machine-group")).toHaveCount(0);
  await page.mouse.up();

  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await expect(page.locator(".machine-group-order-placeholder")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-machine-group-preferences"))).toBeNull();
});

test("session refresh teardown cannot restore a dragged sidebar group", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar lifecycle regression");
  let refreshing = false;
  let refreshRequests = 0;
  let releaseRefresh: () => void = () => {};
  const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [{ hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true }] }),
  }));
  await page.route("https://peer.example.ts.net/api/machine", route => route.fulfill({
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: { tailnetNodeId: "n-peer", installationId, displayName: "verified peer", origin: "https://peer.example.ts.net" },
      wolfpack: { version: "test" },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    }),
  }));
  await page.route("**/api/sessions", async route => {
    if (refreshing) {
      refreshRequests++;
      await refreshReleased;
    }
    const local = new URL(route.request().url()).origin !== "https://peer.example.ts.net";
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: refreshing ? [] : [{ name: local ? "local-session" : "peer-session", triage: "idle" }] }),
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.goto(server.baseUrl);
  await expect(page.locator("#session-list > .machine-group")).toHaveCount(2);
  for (const toggle of await page.locator("#session-list .machine-collapse-toggle").all()) await toggle.click();
  await page.getByRole("button", { name: "Collapse sessions" }).click();
  await expect(page.locator("#sidebar-session-list > .machine-group")).toHaveCount(2);
  const preferencesBeforeDrag = await page.evaluate(() => localStorage.getItem("wolfpack-machine-group-preferences"));

  const localHandle = page.locator('#sidebar-session-list .machine-group[data-machine=""] .machine-name-handle');
  await localHandle.hover();
  await page.mouse.down();
  const localHandleBox = await localHandle.boundingBox();
  expect(localHandleBox).not.toBeNull();
  await page.mouse.move(localHandleBox!.x + 12, localHandleBox!.y + 20, { steps: 2 });
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();

  refreshing = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => refreshRequests).toBeGreaterThanOrEqual(2);
  releaseRefresh();
  await expect(page.locator("#sidebar-session-list > .machine-group")).toHaveCount(0);
  await page.mouse.up();

  await expect(page.locator("#sidebar-session-list > .machine-group")).toHaveCount(0);
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await expect(page.locator(".machine-group-order-placeholder")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-machine-group-preferences"))).toBe(preferencesBeforeDrag);
});

test("machine names expose drag-only reordering and Escape cancels a pending drag", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop pointer cancellation regression");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  const group = mainGroup(page);
  const handle = group.locator(".machine-name-handle");
  const localGroup = page.locator('#session-list .machine-group[data-machine=""]');
  await expect(localGroup).toBeVisible();
  const localBox = await localGroup.boundingBox();
  expect(localBox).not.toBeNull();
  await expect(group.locator(".machine-order-options, [data-machine-menu-offset]")).toHaveCount(0);
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(localBox!.x + localBox!.width / 2, localBox!.y + 8, { steps: 6 });
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual(["", peerIdentity]);
});

for (const width of [320, 375, 390]) test(`R13 Connecting header retains disabled labelled New without overflow at ${width}`, async ({ page }, info) => {
  test.skip(info.project.name !== "iphone-14", "Chromium mobile pending fetch");
  await page.setViewportSize({ width, height: 900 });
  await installMachineFixture(page, true);
  await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "local with a long machine name", version: "test" } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${server.baseUrl}/api/sessions`, async route => {
    await pending;
    await route.fulfill({ json: { sessions: [{ name: "local-session", triage: "idle" }] } });
  });
  await page.goto(server.baseUrl);
  const header = page.locator('#session-list .machine-group[data-machine=""] .machine-header');
  try {
    await expect(header.locator(".machine-header-status")).toHaveText("Connecting…");
    await expect(header.locator(".machine-add-btn")).toBeDisabled();
    await expect(header.locator(".machine-add-btn")).toHaveJSProperty("innerText", "New session");
    await expect(header.locator(".machine-add-label-detail")).toBeVisible();
    await expect(header.locator(".machine-retry-btn")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("connecting-labelled-header.png") });
    await expect.poll(() => header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  } finally { release(); }
  await expect(header.locator(".machine-add-btn")).toBeEnabled();
});

for (const width of [320, 375, 390, 1280]) test(`single-machine session fetch failure retains labelled New, status and retry without overflow at ${width}`, async ({ page }, info) => {
  test.skip(info.project.name !== (width === 1280 ? "desktop" : "iphone-14"), "representative responsive widths");
  await page.setViewportSize({ width, height: 900 });
  await page.route(`${server.baseUrl}/api/info`, route => route.fulfill({ json: { name: "local with a long machine name", version: "test" } }));
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [] }),
  }));
  let reachable = false;
  await page.route("**/api/sessions", route => reachable
    ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [{ name: "local-session", triage: "idle" }] }) })
    : route.abort("connectionrefused"));
  await page.goto(server.baseUrl);

  await collapseInitialSessionMenu(page);
  const group = page.locator('.machine-group[data-machine=""]').filter({ visible: true });
  await expect(group).toHaveCount(1);
  await expect(group).toHaveClass(/offline/);
  await expect(group.locator(".machine-header-status")).toHaveText("Unreachable");
  await expect(group.locator(".machine-group-body")).toContainText("Unreachable");
  await expect(group.locator(".machine-group-body")).not.toContainText("No active sessions");
  await expect(group.locator('[data-action="new-session"]')).toBeDisabled();
  const header = group.locator(".machine-header");
  await expect(group.locator(".machine-header-name")).toHaveAttribute("title", "local with a long machine name");
  expect.soft((await group.locator(".machine-header-name").boundingBox())!.width).toBeGreaterThan(0);
  await expect(group.locator('[data-action="retry-machine"]')).toBeVisible();
  if (width !== 1280) {
    await expect(group.locator(".machine-add-btn")).toHaveJSProperty("innerText", "New session");
    await expect(group.locator(".machine-add-label-detail")).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("offline-labelled-header.png") });
  await expect.poll(() => header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  if (width !== 1280) {
    const toggle = header.locator(".machine-collapse-toggle");
    const create = header.locator(".machine-add-btn");
    const expanded = { toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! };
    await page.touchscreen.tap(expanded.toggle.x + 22, expanded.toggle.y + 22);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect.soft({ toggle: (await toggle.boundingBox())!, create: (await create.boundingBox())! }).toEqual(expanded);
    await page.touchscreen.tap(expanded.toggle.x + 22, expanded.toggle.y + 22);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(group.locator(".machine-header-status")).toHaveText("Unreachable");
  }

  reachable = true;
  await group.locator('[data-action="retry-machine"]').click();
  await expect(group.locator(".card")).toHaveCount(1);
  await expect(group).not.toHaveClass(/offline/);
  await expect(group.locator(".machine-header-status")).toHaveCount(0);
  await expect(group.locator('[data-action="retry-machine"]')).toHaveCount(0);
});
