import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";
import { AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(() => {
  srv?.close();
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
      agentKind: "unknown",
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
  await page.evaluate(() => {
    (window as unknown as { openSession(session: string, machine?: string): void }).openSession("parent", "");
  });

  await expect(page.locator("#delegation-grid-container .delegation-grid-cell")).toHaveCount(6);
  await expect(page.locator("#delegation-grid-container .delegation-grid-cell.collapsed")).toHaveCount(0);
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
  if (testInfo.project.name === "desktop") {
    await page.locator("#expanded-collapse-btn").click();
    await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
  }
  const list = page.locator(testInfo.project.name === "desktop" ? "#sidebar-session-list" : "#session-list");
  const names = list.locator(".card-name");
  const cardNames = () => names.evaluateAll(elements => elements.map(element => element.firstChild?.textContent));
  await expect.poll(cardNames).toEqual(["one", "two", "three"]);

  sessions = [
    fakeSession("three", "three-id", undefined, { state: AGENT_STATUS_STATE.NEEDS_INPUT, unseen: true }),
    fakeSession("one", "one-id"),
    fakeSession("two", "two-id"),
  ];
  await page.evaluate(async () => {
    await (window as unknown as { loadSessions(): Promise<void> }).loadSessions();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(cardNames).toEqual(["one", "two", "three"]);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-session-order"))).toBeNull();

  const threeHandle = list.getByRole("button", { name: "Reorder three" });
  await threeHandle.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(cardNames).toEqual(["three", "one", "two"]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-session-order") ?? "null"))).toEqual({
    version: 1,
    sessions: [
      { machineUrl: "", sessionId: "three-id" },
      { machineUrl: "", sessionId: "one-id" },
      { machineUrl: "", sessionId: "two-id" },
    ],
  });

  sessions = [
    fakeSession("two-renamed", "two-id", undefined, { state: AGENT_STATUS_STATE.NEEDS_INPUT, unseen: true }),
    fakeSession("one-renamed", "one-id", undefined, { state: AGENT_STATUS_STATE.DONE, unseen: true }),
    fakeSession("three-renamed", "three-id", undefined, { state: AGENT_STATUS_STATE.WORKING, unseen: false }),
    fakeSession("new", "new-id"),
  ];
  await page.evaluate(() => (window as unknown as { loadSessions(): Promise<void> }).loadSessions());
  await expect.poll(cardNames).toEqual(["three-renamed", "one-renamed", "two-renamed", "new"]);

  await page.reload();
  if (testInfo.project.name === "desktop") {
    await page.locator("#expanded-collapse-btn").click();
  }
  await expect.poll(cardNames).toEqual(["three-renamed", "one-renamed", "two-renamed", "new"]);

  await list.getByRole("button", { name: "Reset session order" }).click();
  await expect.poll(cardNames).toEqual(["two-renamed", "one-renamed", "three-renamed", "new"]);
});

test("drag handles move root trees without detaching delegation children", async ({ page }, testInfo) => {
  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child", "child-id", { id: "parent-id", name: "parent" }),
    fakeSession("solo", "solo-id"),
  ]);

  await page.goto(srv.baseUrl);
  if (testInfo.project.name === "desktop") {
    await page.locator("#expanded-collapse-btn").click();
  }
  const list = page.locator(testInfo.project.name === "desktop" ? "#sidebar-session-list" : "#session-list");
  const parentCard = list.locator(".delegation-parent-card");
  const soloHandle = list.getByRole("button", { name: "Reorder solo" });
  const cardNames = () => list.locator(".card-name").evaluateAll(elements =>
    elements.map(element => element.firstChild?.textContent),
  );
  await expect.poll(cardNames).toEqual(["parent", "solo"]);

  const parentBox = await parentCard.boundingBox();
  expect(parentBox).not.toBeNull();
  if (testInfo.project.name === "desktop") {
    await soloHandle.dragTo(parentCard, { targetPosition: { x: parentBox!.width / 2, y: 2 } });
  } else {
    await soloHandle.dispatchEvent("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      clientX: parentBox!.x + parentBox!.width / 2,
      clientY: parentBox!.y + parentBox!.height / 2,
      bubbles: true,
    });
    await page.evaluate(({ x, y }) => {
      document.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 7,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        bubbles: true,
      }));
      document.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: 7,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        bubbles: true,
      }));
    }, { x: parentBox!.x + parentBox!.width / 2, y: parentBox!.y + 2 });
  }

  await expect.poll(cardNames).toEqual(["solo", "parent"]);
  await parentCard.getByRole("button", { name: "Expand 1 child agent" }).click();
  await expect.poll(cardNames).toEqual(["solo", "parent", "child"]);
});

test("mobile delegation cards collapse and expand child sessions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile session-list behavior only");

  await routeDelegationSessions(page, [
    fakeSession("parent", "parent-id"),
    fakeSession("child-one", "child-one-id", { id: "parent-id", name: "parent" }),
    fakeSession("child-two", "child-two-id", { id: "parent-id", name: "parent" }),
  ]);

  await page.goto(srv.baseUrl);
  const parentCard = page.locator(".delegation-parent-card", { hasText: "parent" }).first();
  await expect(parentCard).toBeVisible();

  const toggle = parentCard.locator(".delegation-sidebar-toggle");
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".sub-session-card")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".sub-session-card")).toHaveCount(2);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".sub-session-card")).toHaveCount(0);
});
