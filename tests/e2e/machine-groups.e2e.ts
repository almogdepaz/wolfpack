import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

const installationId = "2af8af29-c4fe-44f9-8a99-2a0e35952d74";
const peerIdentity = `n-peer:${installationId}`;

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function installMachineFixture(page: Page, withSessions = false): Promise<void> {
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
        displayName: "verified peer",
        origin: "https://peer.example.ts.net",
      },
      wolfpack: { version: "test" },
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

test("compact machine headers make the name the reorder handle and reserve the chevron for collapse", async ({ page }, testInfo) => {
  await installMachineFixture(page);
  await page.goto(server.baseUrl);
  if (testInfo.project.name === "desktop") await page.getByRole("button", { name: "Expand sessions" }).click();

  const group = mainGroup(page);
  const name = group.getByRole("button", { name: "Reorder verified peer" });
  const toggle = group.getByRole("button", { name: "Collapse verified peer" });
  await expect(name).toHaveClass("machine-name-handle");
  await expect(name).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  await expect(name.locator(".machine-header-name")).toHaveText("verified peer");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("");
  await expect(toggle.locator(":scope > .machine-collapse-chevron")).toBeVisible();
  await expect(toggle.locator(".machine-header-name")).toHaveCount(0);
  await expect(group.locator(".machine-order-handle, .machine-order-move")).toHaveCount(0);

  await toggle.click();
  await expect(group.getByRole("button", { name: "Expand verified peer" })).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".machine-group-body")).toHaveAttribute("hidden", "");
  await expect(group.locator(".machine-group-body")).toHaveAttribute("inert", "");
  await expect(group.locator(".machine-header-btns")).toHaveCount(0);
  await expect(group.locator(".machine-header").getByRole("button")).toHaveCount(2);
  await name.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  await expect(group.getByRole("button", { name: "Start a session on verified peer" })).toHaveCount(0);
  await expect(group.getByRole("button", { name: "Move verified peer up" })).toHaveCount(0);
});

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

  const group = sidebarGroup(page);
  const expandedCreate = group.getByRole("button", { name: "Start a session on verified peer" });
  await expect(expandedCreate).toBeVisible();
  await expandedCreate.click();
  await expect(page.locator("#create-project-action")).toHaveAttribute("aria-label", "Create project on verified peer");

  await page.goto(server.baseUrl);
  const reloadedGroup = sidebarGroup(page);
  await reloadedGroup.getByRole("button", { name: "Collapse verified peer" }).click();
  await expect(reloadedGroup.getByRole("button", { name: "Start a session on verified peer" })).toHaveCount(0);
  await reloadedGroup.getByRole("button", { name: "Expand verified peer" }).click();
  await reloadedGroup.getByRole("button", { name: "Start a session on verified peer" }).click();
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

test("expanded desktop machine cards retain the intended adjacent-card gap", async ({ page }, testInfo) => {
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
  await page.getByRole("button", { name: "Expand sessions" }).click();

  const cards = mainGroup(page).locator(".card");
  await expect(cards).toHaveCount(2);
  const firstBox = await cards.nth(0).boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.y - (firstBox!.y + firstBox!.height)).toBeGreaterThanOrEqual(10);
});

test("machine name move options share order while main and sidebar collapse remain independent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop owns both machine presentation surfaces");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  await sidebarGroup(page).getByRole("button", { name: "Reorder verified peer" }).click();
  await sidebarGroup(page).getByRole("button", { name: "Move verified peer up" }).click();
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
  await expect.poll(() => page.locator("#sidebar-session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  await expect(sidebarGroup(page).getByRole("button", { name: "Collapse verified peer" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Expand sessions" }).click();
  await expect(mainGroup(page).getByRole("button", { name: "Expand verified peer" })).toHaveAttribute("aria-expanded", "false");
});

test("machine move options use ordinary group semantics and keyboard focus", async ({ page }, testInfo) => {
  const tabSkipsButtons = testInfo.project.name === "mobile-webkit";
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);
  if (testInfo.project.name === "desktop") await page.getByRole("button", { name: "Expand sessions" }).click();

  const group = mainGroup(page);
  const handle = group.getByRole("button", { name: "Reorder verified peer" });
  await expect(handle).not.toHaveAttribute("aria-haspopup");
  await handle.click();
  const options = group.locator(".machine-order-options");
  await expect(options).toHaveAttribute("role", "group");
  await expect(options).toHaveAttribute("aria-label", "Move verified peer");
  await expect(options.getByRole("button")).toHaveCount(2);
  await expect(options.getByRole("button", { name: "Move verified peer up" })).toBeFocused();
  if (!tabSkipsButtons) {
    await page.keyboard.press("Tab");
    await expect(options.getByRole("button", { name: "Move verified peer down" })).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(handle).toBeFocused();
});

test("boundary machine moves restore focus from closed popups on both surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "both machine presentation surfaces are desktop-only");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

  const assertBoundaryFocus = async (group: ReturnType<typeof mainGroup>, offset: -1 | 1) => {
    const handle = group.locator(".machine-name-handle");
    await handle.click();
    const options = group.locator(".machine-order-options");
    await options.locator(`[data-machine-menu-offset="${offset}"]`).click();
    await expect(options).toHaveAttribute("hidden", "");
    await expect(handle).toBeFocused();
  };
  const localSidebarGroup = page.locator('#sidebar-session-list .machine-group[data-machine=""]');
  await assertBoundaryFocus(localSidebarGroup, -1);
  await assertBoundaryFocus(sidebarGroup(page), 1);

  await page.getByRole("button", { name: "Expand sessions" }).click();
  const localMainGroup = page.locator('#session-list .machine-group[data-machine=""]');
  await assertBoundaryFocus(localMainGroup, -1);
  await assertBoundaryFocus(mainGroup(page), 1);
});

test("machine popup focus follows retained groups across renders without targeting removed peers", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "both machine presentation surfaces are desktop-only");
  let candidateMode: "ready" | "revoked" = "ready";
  await installMachineFixture(page, true);
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(candidateMode === "ready" ? { candidates: [{
      hostname: "peer.example.ts.net",
      tailnetNodeId: "n-peer",
      origin: "https://peer.example.ts.net",
      online: true,
    }] } : { candidates: [] }),
  }));
  await page.goto(server.baseUrl);

  const assertRetainedFocus = async (group: ReturnType<typeof mainGroup>, filter: string) => {
    const handle = group.locator(".machine-name-handle");
    await handle.click();
    await expect(group.locator('[data-machine-menu-offset="-1"]')).toBeFocused();
    await page.evaluate(selector => document.querySelector<HTMLElement>(selector)?.click(), filter);
    await expect(handle).toBeFocused();
  };
  await assertRetainedFocus(sidebarGroup(page), '#sidebar-session-list [data-session-card-view="idle"]');

  await page.getByRole("button", { name: "Expand sessions" }).click();
  await page.evaluate(() => document.querySelector<HTMLElement>('#session-dashboard-controls [data-session-card-view="all"]')?.click());
  await assertRetainedFocus(mainGroup(page), '#session-dashboard-controls [data-session-card-view="idle"]');

  const peerHandle = mainGroup(page).locator(".machine-name-handle");
  await peerHandle.click();
  await expect(mainGroup(page).locator('[data-machine-menu-offset="-1"]')).toBeFocused();
  candidateMode = "revoked";
  await page.evaluate(() => document.querySelector<HTMLElement>(".discover-btn")?.click());
  await expect(mainGroup(page)).toHaveCount(0);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.machine ?? "")).not.toBe(peerIdentity);
});

test("all-collapsed sidebar groups retain chooser ownership and toggle focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar ownership regression");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

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
  const peerName = mainGroup(page).getByRole("button", { name: "Reorder verified peer" });
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
  await expect(peerName).toBeFocused();
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
  await expect(sidebarGroup(page).getByRole("button", { name: "Open peer-session" })).toBeVisible();
  await sidebarGroup(page).getByRole("button", { name: "Reorder verified peer" }).click();
  await sidebarGroup(page).getByRole("button", { name: "Move verified peer up" }).click();
  await expect.poll(() => page.locator("#sidebar-session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  const peerHandle = sidebarGroup(page).getByRole("button", { name: "Reorder verified peer" });
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
  await expect.poll(() => postRevocationLocalRequests).toBeGreaterThan(0);
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await page.mouse.up();
  const assertCanonicalLocalProjection = async (surface: "#session-list" | "#sidebar-session-list") => {
    const groups = page.locator(`${surface} > .machine-group`);
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAttribute("data-machine", "");
    await expect(groups.first()).toContainText("local-session");
    await expect(groups.first()).not.toContainText("verified peer");
    await expect(groups.first()).not.toContainText("peer-session");
    const actionMachines = await groups.locator('[data-action="new-session"], [data-action="open-session"], [data-action="kill-session"], [data-action="toggle-grid"]')
      .evaluateAll(actions => actions.map(action => (action as HTMLElement).dataset.machine ?? ""));
    expect(actionMachines.length).toBeGreaterThan(0);
    expect(actionMachines).toEqual(actionMachines.map(() => ""));
  };
  try {
    await page.locator("#settings-back-btn").click();
    await page.getByRole("button", { name: "Idle sessions" }).click();
    await page.getByRole("button", { name: "All sessions" }).click();
    await page.evaluate(() => {
      const expand = document.getElementById("sidebar-expand-btn");
      if (!expand?.classList.contains("active")) expand?.click();
    });
    await expect(page.locator("#session-list")).not.toHaveAttribute("hidden", "");
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
  await page.getByRole("button", { name: "Expand sessions" }).click();

  const peerHandle = mainGroup(page).getByRole("button", { name: "Reorder verified peer" });
  const localGroup = page.locator('#session-list .machine-group[data-machine=""]');
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

  const handle = sidebarGroup(page).getByRole("button", { name: "Reorder verified peer" });
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
  await page.getByRole("button", { name: "Expand sessions" }).click();
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

test("machine name move options, keyboard, and pointer alternatives reorder without exposing stable identities", async ({ page }, testInfo) => {
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);
  if (testInfo.project.name === "desktop") await page.getByRole("button", { name: "Expand sessions" }).click();

  const group = mainGroup(page);
  const handle = group.getByRole("button", { name: "Reorder verified peer" });
  const visibleName = handle.locator(".machine-header-name");
  await handle.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  await expect(group.locator(".machine-name-handle")).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  expect(await handle.getAttribute("data-machine")).toBeNull();

  const localGroup = page.locator('#session-list .machine-group[data-machine=""]');
  const localBox = await localGroup.boundingBox();
  expect(localBox).not.toBeNull();
  await visibleName.hover();
  await page.mouse.down();
  await localGroup.locator(".machine-header").hover();
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await expect.poll(() => page.locator(".machine-group-order-placeholder").evaluate(element =>
    (element.nextElementSibling as HTMLElement | null)?.dataset.machine ?? "",
  )).toBe("");
  await localGroup.locator(".machine-group-body").hover();
  await page.mouse.up();
  await expect(page.locator(".machine-order-options:not([hidden])")).toHaveCount(0);
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual(["", peerIdentity]);
  await expect(handle).toBeFocused();

  const reorderedLocalBox = await localGroup.boundingBox();
  expect(reorderedLocalBox).not.toBeNull();
  await visibleName.hover();
  await page.mouse.down();
  await page.mouse.move(reorderedLocalBox!.x + reorderedLocalBox!.width / 2, reorderedLocalBox!.y + 8, { steps: 6 });
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await expect(page.locator(".machine-order-options:not([hidden])")).toHaveCount(0);
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual(["", peerIdentity]);

  await handle.click();
  const options = group.locator(".machine-order-options");
  await expect(options).not.toHaveAttribute("hidden", "");
  await expect(options.getByRole("button", { name: "Move verified peer up" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(options).toHaveAttribute("hidden", "");
  await expect(handle).toBeFocused();
  await handle.click();
  await page.locator("body").dispatchEvent("click");
  await expect(options).toHaveAttribute("hidden", "");
  await handle.click();
  await group.getByRole("button", { name: "Collapse verified peer" }).click();
  await expect(page.locator(".machine-order-options:not([hidden])")).toHaveCount(0);
  await group.getByRole("button", { name: "Expand verified peer" }).click();

});
