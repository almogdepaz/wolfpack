import { writeFile } from "node:fs/promises";
import { collapseInitialSessionMenu, selectTerminalLayoutFromUi } from "./helpers.ts";
import { mockLayoutWidget } from "./widget-fixture.ts";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { openSessionFromUi, startTestServer, type TestServer } from "./helpers.ts";
import { AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  await srv?.close();
});

async function routeHydratedPty(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/pty/, (ws: WebSocketRoute) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-PREFILL\r\n`));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
}

function fakeSession(
  name: string,
  id: string,
  parent?: { readonly id: string; readonly name: string },
  runtimeState: { readonly state: string; readonly unseen: boolean } = { state: AGENT_STATUS_STATE.IDLE, unseen: false },
) {
  return {
    name,
    lastLine: `$ ${name}`,
    triage: AGENT_STATUS_STATE.IDLE,
    runtimeState,
    identity: {
      wolfpackSessionId: id,
      wolfpackSessionName: name,
      projectPath: "",
      agentKind: "custom",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      ...(parent && {
        parentSession: {
          wolfpackSessionId: parent.id,
          wolfpackSessionName: parent.name,
        },
      }),
    },
  };
}

async function dispatchSyntheticTouch(
  page: Page,
  selector: string | null,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  identifier: number,
  clientX: number,
  clientY: number,
  clickSelectorAfter?: string,
): Promise<boolean> {
  return page.evaluate(({ selector, type, identifier, clientX, clientY, clickSelectorAfter }) => {
    const target = selector ? document.querySelector(selector) : document;
    if (!target) throw new Error(`Missing synthetic touch target: ${selector}`);
    const event = new Event(type, { bubbles: true, cancelable: true });
    const touch = { identifier, clientX, clientY, target };
    const activeTouches = type === "touchend" || type === "touchcancel" ? [] : [touch];
    Object.defineProperties(event, {
      touches: { value: activeTouches },
      targetTouches: { value: activeTouches },
      changedTouches: { value: [touch] },
    });
    target.dispatchEvent(event);
    if (clickSelectorAfter) {
      const clickTarget = document.querySelector<HTMLElement>(clickSelectorAfter);
      if (!clickTarget) throw new Error(`Missing post-touch click target: ${clickSelectorAfter}`);
      clickTarget.click();
    }
    return event.defaultPrevented;
  }, { selector, type, identifier, clientX, clientY, clickSelectorAfter });
}

async function routeDelegationSessions(page: Page, sessions: readonly ReturnType<typeof fakeSession>[]): Promise<void> {
  await page.route("**/api/sessions", async route => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions }),
    });
  });
  await page.route("**/api/info", async route => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "test", name: "test" }) });
  });
}

test("desktop parent grid opens every child session expanded", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid behavior only");

  await routeHydratedPty(page);
  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child-one", "child-one-id", { id: "parent-id", name: "parent" }),
    fakeSession("child-two", "child-two-id", { id: "parent-id", name: "parent" }),
    fakeSession("child-three", "child-three-id", { id: "parent-id", name: "parent" }),
    fakeSession("child-four", "child-four-id", { id: "parent-id", name: "parent" }),
    fakeSession("child-five", "child-five-id", { id: "parent-id", name: "parent" }),
  ]);

  await page.goto(srv.baseUrl);
  await expect(page.locator(".delegation-parent-card", { hasText: "parent" }).first()).toBeVisible();
  await openSessionFromUi(page, "parent", "");

  await expect(page.locator("#delegation-grid-container .delegation-grid-cell")).toHaveCount(6);
  await expect(page.locator("#delegation-grid-container .delegation-grid-cell.collapsed")).toHaveCount(0);
  const focusedSession = () => page.locator("#delegation-grid-container .delegation-grid-cell.grid-focused")
    .getAttribute("data-session");
  const visualSessions = await page.locator("#delegation-grid-container .delegation-grid-cell")
    .evaluateAll(cells => cells.map(cell => (cell as HTMLElement).dataset.session ?? ""));
  expect(visualSessions[0]).toBe("parent");
  await expect.poll(focusedSession).toBe(visualSessions[0]);
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect.poll(focusedSession).toBe(visualSessions[0]);
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect.poll(focusedSession).toBe(visualSessions[1]);
});

test("collapsed delegation child retains its controller and broker attach when expanded", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid behavior only");

  const attachCounts = new Map<string, number>();
  const closeCounts = new Map<string, number>();
  await page.routeWebSocket(/\/ws\/pty/, (ws: WebSocketRoute) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    ws.onClose(() => closeCounts.set(session, (closeCounts.get(session) ?? 0) + 1));
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      attachCounts.set(session, (attachCounts.get(session) ?? 0) + 1);
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-PREFILL\r\n`));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child", "child-id", { id: "parent-id", name: "parent" }),
  ]);

  await page.goto(srv.baseUrl);
  await collapseInitialSessionMenu(page);
  await expect(page.locator("#sidebar-session-list .delegation-parent-card")).toBeVisible();
  await openSessionFromUi(page, "parent", "");
  const childCell = page.locator('#delegation-grid-container .delegation-grid-cell[data-session="child"]');
  const focusedSession = () => page.locator("#delegation-grid-container .delegation-grid-cell.grid-focused")
    .getAttribute("data-session");
  await expect(childCell).toHaveAttribute("data-terminal-load-state", "live");
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect.poll(focusedSession).toBe("child");

  await page.getByRole("button", { name: "Collapse child" }).click();
  await expect(page.locator("#delegation-grid-container .delegation-grid-cell.collapsed")).toHaveCount(1);
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect.poll(focusedSession).toBe("parent");
  await expect.poll(() => closeCounts.get("child") ?? 0).toBe(0);
  await page.getByRole("button", { name: "Expand child" }).click();

  await expect(childCell).toHaveAttribute("data-terminal-load-state", "live");
  expect(attachCounts.get("child")).toBe(1);
});

test("explicit workspace shell changes retain delegation panes and focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop workspace geometry behavior only");
  await mockLayoutWidget(page);
  const attachCounts = new Map<string, number>();
  await page.routeWebSocket(/\/ws\/pty/, (ws: WebSocketRoute) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const frame = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (frame.type === "resize") {
        ws.send(JSON.stringify({ ...frame, type: "resize_ack" }));
        return;
      }
      if (frame.type !== "attach") return;
      attachCounts.set(session, (attachCounts.get(session) ?? 0) + 1);
      ws.send(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
      ws.send(Buffer.from(`${session}-WORKSPACE\r\n`));
      if (frame.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await routeDelegationSessions(page, [
    fakeSession("parent", "11111111-1111-4111-8111-111111111111"),
    fakeSession("child", "22222222-2222-4222-8222-222222222222", { id: "11111111-1111-4111-8111-111111111111", name: "parent" }),
  ]);
  await page.goto(srv.baseUrl);
  await openSessionFromUi(page, "parent", "");
  const child = page.locator('#delegation-grid-container .delegation-grid-cell[data-session="child"]');
  await expect(child).toHaveAttribute("data-terminal-load-state", "live");
  await child.click();
  await expect(child).toHaveClass(/grid-focused/);
  await selectTerminalLayoutFromUi(page, "lead-stack");
  await expect(child).toHaveAttribute("data-terminal-load-state", "live");
  await expect(child).toHaveClass(/grid-focused/);
  // The Settings page suspends viewers; returning must restore the same workspace.
  expect(attachCounts.get("parent")).toBe(2);
  expect(attachCounts.get("child")).toBe(2);
  await expect(page.locator("#delegation-grid-container")).toHaveAttribute("style", /grid-template-columns/);
  await page.getByRole("button", { name: "Collapse Widgets", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Widgets", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Widgets", exact: true }).click();
  await page.locator("[data-widget-full]:visible").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(child).toHaveClass(/grid-focused/);
  expect(attachCounts.get("parent")).toBe(2);
  expect(attachCounts.get("child")).toBe(2);
});

test("workspace shell mobile recovery keeps a visible terminal usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "mobile WebKit workspace behavior only");
  let attaches = 0;
  await page.routeWebSocket(/\/ws\/pty/, (ws: WebSocketRoute) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const frame = JSON.parse(message) as { readonly type?: string };
      if (frame.type !== "attach") return;
      attaches++;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("MOBILE-WORKSPACE\r\n"));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await routeDelegationSessions(page, [fakeSession("parent", "parent-id")]);
  await page.goto(srv.baseUrl);
  await openSessionFromUi(page, "parent", "");
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await page.locator("#workspace-restore").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await page.locator("#workspace-context-back").click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  expect(attaches).toBe(1);
});

test("manual card order persists by stable identity and resets to server order", async ({ page }, testInfo) => {
  let sessions = [
    fakeSession("one", "one-id"),
    fakeSession("two", "two-id"),
    fakeSession("three", "three-id"),
  ];
  await page.route("**/api/sessions", async route => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions }) });
  });
  await page.route("**/api/info", async route => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "test", name: "test" }) });
  });

  await page.goto(srv.baseUrl);
  await collapseInitialSessionMenu(page);
  const list = page.locator(testInfo.project.name === "desktop" ? "#sidebar-session-list" : "#session-list");
  const names = list.locator('.card[data-session-order-machine=""] .card-name');
  const cardNames = () => names.evaluateAll(elements => elements.map(element => element.querySelector(".card-name-text")?.textContent));
  await expect.poll(cardNames).toEqual(["one", "two", "three"]);

  sessions = [
    fakeSession("three", "three-id", undefined, { state: AGENT_STATUS_STATE.NEEDS_INPUT, unseen: true }),
    fakeSession("one", "one-id"),
    fakeSession("two", "two-id"),
  ];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(cardNames).toEqual(["one", "two", "three"]);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-session-order"))).toBeNull();

  const threeRow = list.locator('.card[data-session-order-machine=""][data-session-order-id="three-id"]');
  // The names stay identical across this async refresh; wait for its new rendered data.
  await expect(threeRow).toContainText("changed since review");
  const threeCard = threeRow.locator(".card-open");
  await threeCard.focus(); await expect(threeCard).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(cardNames).toEqual(["one", "three", "two"]);
  await expect(threeCard).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(cardNames).toEqual(["three", "one", "two"]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-session-order") ?? "null"))).toEqual({
    version: 1,
    sessions: [{ machineUrl: "", sessionId: "three-id", position: 0, tier: "idle" }],
  });

  sessions = [
    fakeSession("two-renamed", "two-id", undefined, { state: AGENT_STATUS_STATE.NEEDS_INPUT, unseen: true }),
    fakeSession("one-renamed", "one-id", undefined, { state: AGENT_STATUS_STATE.DONE, unseen: true }),
    fakeSession("three-renamed", "three-id", undefined, { state: AGENT_STATUS_STATE.WORKING, unseen: false }),
    fakeSession("new", "new-id"),
  ];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(cardNames).toEqual(["three-renamed", "one-renamed", "two-renamed", "new"]);

  await page.reload();
  await collapseInitialSessionMenu(page);
  // Untouched rows use the current server fallback when no activity timestamps exist.
  await expect.poll(cardNames).toEqual(["three-renamed", "two-renamed", "one-renamed", "new"]);

  await list.getByRole("button", { name: "Reset session order" }).click();
  await expect.poll(cardNames).toEqual(["two-renamed", "one-renamed", "three-renamed", "new"]);
});

test("desktop cmd+up/down follows the rendered manual card order", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard navigation only");
  await routeHydratedPty(page);
  await routeDelegationSessions(page, [
    fakeSession("one", "one-id"),
    fakeSession("two", "two-id"),
    fakeSession("three", "three-id"),
  ]);
  await page.goto(srv.baseUrl);
  await collapseInitialSessionMenu(page);

  const list = page.locator("#sidebar-session-list");
  const threeCard = list.locator('.card[data-session-order-id="three-id"] .card-open');
  await threeCard.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => list.locator('.card[data-session-order-machine=""] .card-name')
    .evaluateAll((elements) => elements.map((element) => element.querySelector(".card-name-text")?.textContent))).toEqual(["one", "three", "two"]);

  await openSessionFromUi(page, "one", "");
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(list.locator('[data-action="open-session"][aria-current="page"]'))
    .toHaveAttribute("data-session", "one");
  await page.keyboard.press("Meta+ArrowDown");
  await expect(list.locator('[data-action="open-session"][aria-current="page"]'))
    .toHaveAttribute("data-session", "three");
});

test("desktop card reordering keeps an auto-expanded sidebar open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar reorder behavior only");
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "0");
  });
  await routeHydratedPty(page);
  await routeDelegationSessions(page, [
    fakeSession("one", "one-id"),
    fakeSession("two", "two-id"),
  ]);

  await page.goto(srv.baseUrl);
  await openSessionFromUi(page, "one");

  const sidebar = page.locator("#desktop-sidebar");
  await expect(sidebar).toHaveClass(/collapsed/);
  await page.locator("#sidebar-hover-edge").dispatchEvent("mouseenter");
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const secondCard = page.locator('#sidebar-session-list .card[data-session-order-machine=""][data-session-order-id="two-id"]');
  await expect(secondCard).toBeVisible();
  const dragStarted = await secondCard.evaluate((element) => {
    const target = element.querySelector<HTMLElement>(".card-open");
    if (!target) throw new Error("missing card open control");
    const rect = element.getBoundingClientRect();
    const start = { x: rect.x + 16, y: rect.y + rect.height / 2 };
    target.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 17,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: start.x,
      clientY: start.y,
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 17,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: start.x + 20,
      clientY: start.y,
    }));
    return document.querySelector(".session-order-floating") !== null;
  });
  expect(dragStarted).toBe(true);
  await expect(page.locator(".session-order-floating")).toBeVisible();
  await sidebar.dispatchEvent("mouseleave");
  await page.waitForTimeout(350);
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 17,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 0,
    }));
  });
});

test("direct card drag previews live movement and keeps delegation children attached", async ({ page }, testInfo) => {
  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child", "child-id", { id: "parent-id", name: "parent" }),
    fakeSession("solo", "solo-id"),
  ]);

  await page.goto(srv.baseUrl);
  await collapseInitialSessionMenu(page);
  const list = page.locator(testInfo.project.name === "desktop" ? "#sidebar-session-list" : "#session-list");
  const parentCard = list.locator('.delegation-parent-card[data-session-order-machine=""]');
  const soloCard = list.locator('.card[data-session-order-machine=""][data-session-order-id="solo-id"]');
  const cardNames = () => list.locator('.card[data-session-order-machine=""] .card-name').evaluateAll(elements =>
    elements.map(element => element.querySelector(".card-name-text")?.textContent),
  );
  await expect.poll(cardNames).toEqual(["parent", "solo"]);

  if (testInfo.project.name === "desktop") {
    await expect.poll(async () => (await soloCard.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  }
  const parentBox = await parentCard.boundingBox();
  const soloBox = await soloCard.boundingBox();
  expect(parentBox).not.toBeNull();
  expect(soloBox).not.toBeNull();
  const target = { x: parentBox!.x + parentBox!.width / 2, y: parentBox!.y + parentBox!.height / 4 };
  if (testInfo.project.name === "desktop") {
    await page.mouse.move(soloBox!.x + soloBox!.width / 2, soloBox!.y + soloBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
  } else {
    const soloSelector = `${testInfo.project.name === "desktop" ? "#sidebar-session-list" : "#session-list"} .card[data-session-order-machine=""][data-session-order-id="solo-id"]`;
    const origin = { x: soloBox!.x + soloBox!.width / 2, y: soloBox!.y + soloBox!.height / 2 };
    await dispatchSyntheticTouch(page, soloSelector, "touchstart", 6, origin.x, origin.y);
    const preActivationMovePrevented = await dispatchSyntheticTouch(page, null, "touchmove", 6, origin.x, origin.y + 12);
    expect(preActivationMovePrevented).toBe(false);
    await page.waitForTimeout(350);
    await expect(page.locator(".session-order-floating")).toHaveCount(0);
    await dispatchSyntheticTouch(page, null, "touchend", 6, origin.x, origin.y + 12);

    await dispatchSyntheticTouch(page, soloSelector, "touchstart", 7, origin.x, origin.y);
    await page.waitForTimeout(350);
    await expect(page.locator(".session-order-floating")).toBeVisible();
    const activeMovePrevented = await dispatchSyntheticTouch(page, null, "touchmove", 7, target.x, target.y);
    expect(activeMovePrevented).toBe(true);
  }

  const floating = page.locator(".session-order-floating");
  const placeholder = list.locator(".session-order-placeholder");
  await expect(floating).toBeVisible();
  await expect(floating).toContainText("solo");
  await expect(placeholder).toHaveCount(1);
  await expect.poll(() => placeholder.evaluate(element =>
    element.nextElementSibling?.querySelector(".card-name-text")?.textContent,
  )).toBe("parent");
  await expect.poll(async () => (await parentCard.boundingBox())?.y ?? parentBox!.y)
    .toBeGreaterThan(parentBox!.y + 10);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-session-order"))).toBeNull();

  if (testInfo.project.name === "desktop") {
    await page.mouse.up();
  } else {
    await dispatchSyntheticTouch(page, null, "touchend", 7, target.x, target.y);
  }

  await expect.poll(cardNames).toEqual(["solo", "parent"]);
  await expect(floating).toHaveCount(0);
  await expect(placeholder).toHaveCount(0);
  await expect(page.locator('[data-action="open-session"][aria-current="page"]')).toHaveCount(0);
  await parentCard.getByRole("button", { name: "Expand 1 child agent" }).click();
  await expect.poll(cardNames).toEqual(["solo", "parent", "child"]);
});

test("desktop escape cancels a nested card drag and restores the hierarchy", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop pointer cancellation only");

  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child", "child-id", { id: "parent-id", name: "parent" }),
    fakeSession("solo", "solo-id"),
  ]);

  await page.goto(srv.baseUrl);
  await collapseInitialSessionMenu(page);
  const list = page.locator("#sidebar-session-list");
  const parentCard = list.locator('.delegation-parent-card[data-session-order-machine=""]');
  const childCard = list.locator('.sub-session-card[data-session-order-machine=""]');
  const soloCard = list.locator('.card[data-session-order-machine=""][data-session-order-id="solo-id"]');
  await parentCard.getByRole("button", { name: "Expand 1 child agent" }).click();
  await expect(childCard).toBeVisible();
  await expect(parentCard).toBeVisible();
  await expect(soloCard).toBeVisible();
  const parentBox = await parentCard.boundingBox();
  const soloBox = await soloCard.boundingBox();
  expect(parentBox).not.toBeNull();
  expect(soloBox).not.toBeNull();

  await page.mouse.move(parentBox!.x + 16, parentBox!.y + parentBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(soloBox!.x + 16, soloBox!.y + soloBox!.height / 2, { steps: 8 });
  await expect(page.locator(".session-order-floating")).toBeVisible();
  await expect(childCard).not.toBeVisible();

  await page.keyboard.press("Escape");
  await page.mouse.up();

  await expect(page.locator(".session-order-floating")).toHaveCount(0);
  await expect(page.locator(".session-order-placeholder")).toHaveCount(0);
  await expect(childCard).toBeVisible();
  await expect(list.locator('.card[data-session-order-machine=""] .card-name-text')).toHaveText(["parent", "child", "solo"]);
});

test("mobile moved card opens its terminal immediately after touch reorder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile touch behavior only");

  await routeHydratedPty(page);
  await routeDelegationSessions(page, [
    fakeSession("first", "first-id"),
    fakeSession("second", "second-id"),
  ]);

  await page.goto(srv.baseUrl);
  const list = page.locator("#session-list");
  const firstCard = list.locator('.card[data-session-order-machine=""][data-session-order-id="first-id"]');
  const secondCard = list.locator('.card[data-session-order-machine=""][data-session-order-id="second-id"]');
  const firstBox = await firstCard.boundingBox();
  const secondBox = await secondCard.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const origin = { x: secondBox!.x + secondBox!.width / 2, y: secondBox!.y + secondBox!.height / 2 };
  const target = { x: firstBox!.x + firstBox!.width / 2, y: firstBox!.y + firstBox!.height / 4 };
  const secondSelector = '#session-list .card[data-session-order-machine=""][data-session-order-id="second-id"]';

  await dispatchSyntheticTouch(page, secondSelector, "touchstart", 12, origin.x, origin.y);
  await page.waitForTimeout(350);
  await dispatchSyntheticTouch(page, null, "touchmove", 12, target.x, target.y);
  await expect(page.locator(".session-order-floating")).toBeVisible();
  await dispatchSyntheticTouch(page, null, "touchend", 12, target.x, target.y, `${secondSelector} .card-open`);

  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#chip-label")).toHaveText("second");
});

test("expanded child cards stay compact and inside the session list", async ({ page }, testInfo) => {
  await routeDelegationSessions(page, [
    { ...fakeSession("parent-with-a-deliberately-long-name", "parent-id"), lastLine: "$ same preview" },
    fakeSession("child-with-a-deliberately-long-name", "child-id", { id: "parent-id", name: "parent-with-a-deliberately-long-name" }),
    { ...fakeSession("solo", "solo-id"), lastLine: "$ same preview" },
  ]);

  await page.goto(srv.baseUrl);
  await collapseInitialSessionMenu(page);
  if (testInfo.project.name === "desktop") {
    await expect.poll(async () => (await page.locator('#sidebar-session-list .delegation-parent-card[data-session-order-machine=""]').boundingBox())?.x ?? -1)
      .toBeGreaterThanOrEqual(0);
  }
  const list = page.locator(testInfo.project.name === "desktop" ? "#sidebar-session-list" : "#session-list");
  const parentCard = list.locator('.delegation-parent-card[data-session-order-machine=""]');
  const soloCard = list.locator('.card[data-session-order-machine=""][data-session-order-id="solo-id"]');
  const toggle = parentCard.locator(".delegation-sidebar-toggle");
  await expect(parentCard).toBeVisible();
  await expect(toggle).toHaveText(/1 agent$/);
  const collapsedChevron = await toggle.locator(".delegation-sidebar-toggle-icon")
    .evaluate(element => {
      const style = getComputedStyle(element);
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        stroke: Number.parseFloat(style.borderRightWidth),
        gap: Number.parseFloat(getComputedStyle(element.parentElement!).columnGap),
        fontSize: Number.parseFloat(getComputedStyle(element.parentElement!).fontSize),
        transform: style.transform,
      };
    });
  expect(collapsedChevron.width).toBeGreaterThanOrEqual(7);
  expect(collapsedChevron.height).toBeGreaterThanOrEqual(7);
  expect(collapsedChevron.stroke).toBeGreaterThanOrEqual(2);
  expect(collapsedChevron.gap).toBeGreaterThanOrEqual(8);
  expect(collapsedChevron.fontSize).toBeGreaterThanOrEqual(testInfo.project.name === "desktop" ? 10 : 11);
  const togglePaddingTop = await toggle.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingTop));
  expect(togglePaddingTop).toBeGreaterThanOrEqual(testInfo.project.name === "desktop" ? 2 : 3);
  const collapsedParentBox = await parentCard.boundingBox();
  const soloBox = await soloCard.boundingBox();
  expect(collapsedParentBox).not.toBeNull();
  expect(soloBox).not.toBeNull();
  await testInfo.attach("collapsed-row-geometry", {
    body: JSON.stringify(await list.locator('.delegation-parent-card, [data-session-order-id="solo-id"]').evaluateAll(cards => cards.map(card => ({
      id: (card as HTMLElement).dataset.sessionOrderId,
      parts: [card, ...card.querySelectorAll('.card-info, .card-name, .card-preview, .card-status, .delegation-sidebar-toggle')].map(el => {
        const style = getComputedStyle(el);
        return { className: el.className, height: style.height, borderTop: style.borderTopWidth, padding: style.padding, lineHeight: style.lineHeight, marginTop: style.marginTop };
      }),
    }))), null, 2),
    contentType: "application/json",
  });
  await expect(parentCard).toHaveCSS("height", await soloCard.evaluate(el => getComputedStyle(el).height));
  expect(Math.abs(collapsedParentBox!.height - soloBox!.height)).toBeLessThanOrEqual(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText(/1 agent$/);
  await expect.poll(() => toggle.locator(".delegation-sidebar-toggle-icon")
    .evaluate(element => getComputedStyle(element).transform)).not.toBe(collapsedChevron.transform);

  const childCard = list.locator('.sub-session-card[data-session-order-machine=""]');
  await expect(childCard).toBeVisible();
  const listBox = await list.boundingBox();
  const parentBox = await parentCard.boundingBox();
  const childBox = await childCard.boundingBox();
  const toggleBox = await toggle.boundingBox();
  expect(listBox).not.toBeNull();
  expect(parentBox).not.toBeNull();
  expect(childBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThan(parentBox!.x);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width + 0.5);
  expect(toggleBox!.height).toBeLessThanOrEqual(testInfo.project.name === "desktop" ? 20 : 22);
  const fontSizes = await page.evaluate(() => ({
    parent: Number.parseFloat(getComputedStyle(document.querySelector(".delegation-parent-card .card-name")!).fontSize),
    child: Number.parseFloat(getComputedStyle(document.querySelector(".sub-session-card .card-name")!).fontSize),
  }));
  expect(fontSizes.child).toBeLessThan(fontSizes.parent);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("mobile drawer groups child sessions directly under their parent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile session drawer behavior only");

  await routeHydratedPty(page);
  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child", "child-id", { id: "parent-id", name: "parent" }),
    fakeSession("solo", "solo-id"),
  ]);

  await page.goto(srv.baseUrl);
  await page.locator('#session-list .card[data-session-order-machine=""][data-session-order-id="parent-id"] .card-open').click();
  await page.locator("#session-chip").click();
  const drawer = page.locator("#session-drawer");
  await expect(drawer).toHaveClass(/open/);

  const localItems = drawer.locator('.drawer-item[data-val="parent"], .drawer-item[data-val="child"], .drawer-item[data-val="solo"]');
  const localNames = () => localItems.locator(".drawer-item-name").allTextContents();
  await expect.poll(localNames).toEqual(["parent", "solo"]);

  const parentItem = drawer.locator('.drawer-item[data-val="parent"]');
  const toggle = parentItem.locator("..").locator(".delegation-sidebar-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Expand 1 child agent");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox).not.toBeNull();
  const toggleSelector = '#drawer-list .drawer-item[data-val="parent"] + .delegation-sidebar-toggle';
  await dispatchSyntheticTouch(page, toggleSelector, "touchstart", 11, toggleBox!.x + 4, toggleBox!.y + 4);
  await dispatchSyntheticTouch(page, toggleSelector, "touchend", 11, toggleBox!.x + 4, toggleBox!.y + 4);
  await expect(drawer).toHaveClass(/open/);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(localNames).toEqual(["parent", "child", "solo"]);

  const childItem = drawer.locator('.drawer-item[data-val="child"]');
  await expect(childItem).toHaveClass(/drawer-child-item/);
  const parentBox = await parentItem.boundingBox();
  const childBox = await childItem.boundingBox();
  const drawerBox = await drawer.boundingBox();
  expect(parentBox).not.toBeNull();
  expect(childBox).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThan(parentBox!.x);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(drawerBox!.x + drawerBox!.width + 0.5);
});

test("dashboard delegation cards hide children until toggled and visibly nest expanded rows", async ({ page }, testInfo) => {
  const width = testInfo.project.name === "desktop" ? 1440 : testInfo.project.name === "iphone-se" ? 375 : 390;
  await page.setViewportSize({ width, height: 900 });

  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child-one", "child-one-id", { id: "parent-id", name: "parent" }),
    fakeSession("child-two", "child-two-id", { id: "parent-id", name: "parent" }),
  ]);

  await page.goto(srv.baseUrl);
  const dashboard = page.locator("#session-list .machine-group:not(.needs-you)");
  const parentCard = dashboard.locator('.card[data-session-order-id="parent-id"]');
  const children = dashboard.locator(".sub-session-card");
  await expect(parentCard).toBeVisible();

  const toggle = parentCard.getByRole("button", { name: "Expand 2 child agents", exact: true });
  await expect(toggle).toHaveText("2 agents");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(children).toHaveCount(0);

  await toggle.click();
  const collapse = parentCard.getByRole("button", { name: "Collapse 2 child agents", exact: true });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(children).toHaveCount(2);
  await expect(page.locator("#sessions-view")).toBeVisible();
  await expect(page.locator("#terminal-view")).toHaveAttribute("aria-hidden", "true");
  // A separate existing focus/reparent issue scrolls the shared horizontal
  // viewport on toggle. Normalize it for nesting captures, not production CSS.
  await page.locator("#view-container").evaluate(el => { el.scrollLeft = 0; });
  await expect.poll(() => dashboard.evaluate(el => el.getBoundingClientRect().x)).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath(`expanded-${width}.png`), fullPage: true, animations: "disabled" });
  // Measure actual name/icon content, not merely the row's margin. On the
  // transparent reskin the old 18px margin was perceptually almost flat.
  const geometry = await children.evaluateAll(rows => rows.map(row => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const group = row.closest(".machine-group-body")!;
    const parent = group.querySelector(".delegation-parent-card")!;
    const style = getComputedStyle(row, "::before");
    const box = rect(row);
    const borderLeft = Number.parseFloat(style.borderLeftWidth);
    const borderBottom = Number.parseFloat(style.borderBottomWidth);
    const connector = {
      content: style.content, position: style.position,
      x: box.x + Number.parseFloat(style.left),
      y: box.y + Number.parseFloat(getComputedStyle(row).borderTopWidth) + Number.parseFloat(style.top),
      width: Number.parseFloat(style.width), height: Number.parseFloat(style.height),
      borderLeft, borderBottom, color: style.borderLeftColor,
    };
    // Composite the translucent group surface over its actual ancestors.
    const composite = (element: Element | null): number[] => {
      if (!element) return [0, 0, 0];
      const rgba = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.map(Number);
      const alpha = rgba[3] ?? 1;
      const behind = composite(element.parentElement);
      return rgba.slice(0, 3).map((channel, i) => channel * alpha + behind[i]! * (1 - alpha));
    };
    const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [ .2126, .7152, .0722 ][i]!, 0);
    const ink = style.borderLeftColor.match(/[\d.]+/g)!.map(Number);
    const surface = composite(group);
    const alpha = ink[3] ?? 1;
    const light = luminance(ink.slice(0, 3).map((channel, i) => channel * alpha + surface[i]! * (1 - alpha)));
    const dark = luminance(surface);
    return {
      box, group: rect(group), parent: rect(parent),
      name: rect(row.querySelector(".card-name-text")!), parentName: rect(parent.querySelector(".card-name-text")!),
      icon: rect(row.querySelector(".harness-icon")!), parentIcon: rect(parent.querySelector(".harness-icon")!),
      fontSize: Number.parseFloat(getComputedStyle(row.querySelector(".card-name")!).fontSize),
      separator: getComputedStyle(row).borderTopColor, connector, surface,
      connectorContrast: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05),
    };
  }));
  const geometryPath = testInfo.outputPath(`expanded-${width}-geometry.json`);
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await testInfo.attach("expanded-nesting-geometry", { path: geometryPath, contentType: "application/json" });
  for (const row of geometry) {
    expect(row.name.x - row.parentName.x, "child NAME must visibly nest, not just its box").toBeGreaterThanOrEqual(28);
    expect(row.icon.x - row.parentName.x, "child icon must start right of the parent name").toBeGreaterThan(0);
    expect(row.icon.x - row.parentIcon.x).toBeGreaterThanOrEqual(28);
    expect(row.box.x - row.parent.x, "hairline starts at the child indent").toBeGreaterThanOrEqual(28);
    expect(row.separator).not.toBe("rgba(0, 0, 0, 0)");
    expect(row.box.x + row.box.width).toBeLessThanOrEqual(row.group.x + row.group.width);
    expect(row.name.width).toBeGreaterThanOrEqual(100);
    expect(row.name.x + row.name.width).toBeLessThanOrEqual(row.box.x + row.box.width);
    expect(row.group.x).toBeGreaterThanOrEqual(0);
    expect(row.group.x + row.group.width).toBeLessThanOrEqual(width);
    expect(row.fontSize).toBeGreaterThanOrEqual(12);
    expect(row.connector.content).toBe('""');
    expect(row.connector.position).toBe("absolute");
    expect(row.connector.width).toBeGreaterThan(0);
    expect(row.connector.height).toBeGreaterThan(0);
    expect(row.connector.borderLeft).toBeGreaterThan(0);
    expect(row.connector.borderBottom).toBeGreaterThan(0);
    expect(row.connector.color).not.toBe("rgba(0, 0, 0, 0)");
    expect(row.connectorContrast, "connector must contrast with the composited reskin surface").toBeGreaterThanOrEqual(3);
    expect(row.connector.x).toBeGreaterThan(row.group.x);
    expect(row.connector.x + row.connector.width).toBeLessThan(row.box.x);
    expect(row.connector.y).toBeGreaterThanOrEqual(row.group.y);
    expect(row.connector.y + row.connector.height).toBeLessThan(row.box.y + row.box.height);
  }
  const parentBox = await parentCard.boundingBox();
  expect(parentBox).not.toBeNull();
  for (const child of await children.all()) {
    await expect(child).toBeVisible();
    const childBox = await child.boundingBox();
    expect(childBox).not.toBeNull();
    expect(childBox!.x).toBeGreaterThan(parentBox!.x);
    expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(parentBox!.x + parentBox!.width + 1);
    expect(childBox!.y).toBeGreaterThanOrEqual(parentBox!.y + parentBox!.height);
    const connector = await child.evaluate(el => {
      const style = getComputedStyle(el, "::before");
      return { content: style.content, border: style.borderLeftWidth, left: Number.parseFloat(style.left) };
    });
    expect(connector.content).toBe('""');
    expect(connector.border).toBe("1px");
    expect(connector.left).toBeLessThan(0);
  }

  await collapse.click();
  await expect(parentCard.getByRole("button", { name: "Expand 2 child agents", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(children).toHaveCount(0);
  await expect(page.locator("#sessions-view")).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await collapseInitialSessionMenu(page);
    const sidebar = page.locator("#sidebar-session-list");
    await expect(sidebar.locator(".sub-session-card")).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Expand 2 child agents", exact: true }).click();
    await expect(sidebar.locator(".sub-session-card")).toHaveCount(2);
    await page.locator("#sidebar-expand-btn").click();
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await expect(children).toHaveCount(2);
    await collapse.click();
    await expect(children).toHaveCount(0);
  }
});
