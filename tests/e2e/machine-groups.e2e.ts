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

test("machine headers provide an independent collapse control and retain empty creation", async ({ page }, testInfo) => {
  await installMachineFixture(page);
  await page.goto(server.baseUrl);
  if (testInfo.project.name === "desktop") await page.getByRole("button", { name: "Expand sessions" }).click();

  const group = mainGroup(page);
  const toggle = group.getByRole("button", { name: "Collapse verified peer" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle.locator(".machine-collapse-chevron")).toBeVisible();

  await toggle.click();
  await expect(group.getByRole("button", { name: "Expand verified peer" })).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".machine-group-body")).toHaveAttribute("hidden", "");
  await expect(group.locator(".machine-group-body")).toHaveAttribute("inert", "");
  await expect(group.getByRole("button", { name: "Start a session on verified peer" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Move verified peer up" })).toBeVisible();
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
  const collapsedCreate = reloadedGroup.getByRole("button", { name: "Start a session on verified peer" });
  await expect(collapsedCreate).toBeVisible();
  await collapsedCreate.click();
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

test("machine move controls share order while main and sidebar collapse remain independent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop owns both machine presentation surfaces");
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);

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

  const localHandle = page.locator('#sidebar-session-list .machine-group[data-machine=""] .machine-order-handle');
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

test("machine keyboard and pointer alternatives reorder without exposing stable identities", async ({ page }, testInfo) => {
  await installMachineFixture(page, true);
  await page.goto(server.baseUrl);
  if (testInfo.project.name === "desktop") await page.getByRole("button", { name: "Expand sessions" }).click();

  const group = mainGroup(page);
  const handle = group.getByRole("button", { name: "Reorder verified peer" });
  await handle.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual([peerIdentity, ""]);
  await expect(group.locator(".machine-order-handle")).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  expect(await handle.getAttribute("data-machine")).toBeNull();

  const localGroup = page.locator('#session-list .machine-group[data-machine=""]');
  const localBox = await localGroup.boundingBox();
  expect(localBox).not.toBeNull();
  await handle.hover();
  await page.mouse.down();
  await localGroup.locator(".machine-header").hover();
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await expect.poll(() => page.locator(".machine-group-order-placeholder").evaluate(element =>
    (element.nextElementSibling as HTMLElement | null)?.dataset.machine ?? "",
  )).toBe("");
  await localGroup.locator(".machine-group-body").hover();
  await page.mouse.up();
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual(["", peerIdentity]);

  const reorderedLocalBox = await localGroup.boundingBox();
  expect(reorderedLocalBox).not.toBeNull();
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(reorderedLocalBox!.x + reorderedLocalBox!.width / 2, reorderedLocalBox!.y + 8, { steps: 6 });
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  await expect.poll(() => page.locator("#session-list > .machine-group").evaluateAll(groups =>
    groups.map(group => (group as HTMLElement).dataset.machine ?? ""),
  )).toEqual(["", peerIdentity]);

  const touchHandleBox = await handle.boundingBox();
  expect(touchHandleBox).not.toBeNull();
  await handle.dispatchEvent("pointerdown", {
    pointerId: 41,
    pointerType: "touch",
    isPrimary: true,
    clientX: touchHandleBox!.x + touchHandleBox!.width / 2,
    clientY: touchHandleBox!.y + touchHandleBox!.height / 2,
  });
  await page.waitForTimeout(350);
  await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
  await page.locator("body").dispatchEvent("pointercancel", { pointerId: 41, pointerType: "touch", isPrimary: true });
  await expect(page.locator(".machine-group-drag-floating")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const event = new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch" });
    document.getElementById("session-list")?.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
});
