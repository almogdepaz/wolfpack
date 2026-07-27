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

function fakeSession(name: string, id: string, parent?: { readonly id: string; readonly name: string }) {
  return {
    name,
    lastLine: `$ ${name}`,
    triage: AGENT_STATUS_STATE.IDLE,
    runtimeState: { state: AGENT_STATUS_STATE.IDLE, unseen: false },
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
