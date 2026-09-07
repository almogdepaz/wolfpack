/**
 * Passive inspection — an inspector receives a bounded broker snapshot without
 * joining the PTY viewer lifecycle or changing the controller's geometry.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrokerClient } from "../../src/broker/client.ts";
import { plainLine } from "../../src/broker/snapshot-render.ts";
import type { StyledLine } from "../../src/broker/snapshot-render.ts";
import { start, skipIfNoBroker } from "./broker-helpers.ts";
import type { BrokerTestServer } from "./broker-helpers.ts";
import { openSessionFromUi } from "./helpers.ts";

const PROJECT_NAME = "wp-passive-inspection";
const SESSION_NAME = "passive-inspection-shell";
const REFRESH_INTERVAL_MS = 2_000;

interface BrokerSessionGeometry {
  readonly cols: number;
  readonly rows: number;
}

interface BrokerSnapshotPayload {
  readonly visible_screen?: StyledLine[];
}

let server: BrokerTestServer | null = null;
let projectRoot: string | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectBroker(socketPath: string): Promise<BrokerClient> {
  let resolveConnect!: () => void;
  const connected = new Promise<void>((resolve) => { resolveConnect = resolve; });
  const client = new BrokerClient({
    socketPath,
    requestTimeoutMs: 5_000,
    onConnect: () => resolveConnect(),
  });
  client.start();
  try {
    await Promise.race([
      connected,
      wait(2_000).then(() => { throw new Error("broker test observer did not connect"); }),
    ]);
    return client;
  } catch (error: unknown) {
    client.close();
    throw error;
  }
}

async function waitForDeadTombstone(client: BrokerClient, sessionId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listed = await client.request("list_sessions", {});
    const liveSessions = (listed.payload as { readonly sessions?: ReadonlyArray<{ readonly id?: string }> } | undefined)?.sessions ?? [];
    const info = await client.request("session_info", { session_id: sessionId });
    const session = (info.payload as { readonly session?: { readonly alive?: unknown } } | undefined)?.session;
    if (!liveSessions.some((candidate) => candidate.id === sessionId) && info.status === "ok" && session?.alive === false) return;
    await wait(50);
  }
  throw new Error("broker did not expose the expected dead-session tombstone");
}

async function brokerSessionGeometry(client: BrokerClient, sessionId: string): Promise<BrokerSessionGeometry> {
  const response = await client.request("session_info", { session_id: sessionId });
  expect(response.status).toBe("ok");
  const session = (response.payload as { readonly session?: Record<string, unknown> } | undefined)?.session;
  const cols = session?.cols;
  const rows = session?.rows;
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error("broker session_info response omitted valid geometry");
  }
  return { cols, rows };
}

async function waitForSnapshotText(
  client: BrokerClient,
  sessionId: string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await client.request("snapshot", {
      session_id: sessionId,
      scrollback_lines: 0,
    });
    const snapshot = (response.payload as { readonly snapshot?: BrokerSnapshotPayload } | undefined)?.snapshot;
    const text = (snapshot?.visible_screen ?? []).map((line) => plainLine(line)).join("\n");
    if (text.includes(marker)) return;
    await wait(100);
  }
  throw new Error(`broker snapshot never included ${marker}`);
}

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "wp-passive-inspection-")));
  mkdirSync(join(projectRoot, PROJECT_NAME));
  server = await start({ envOverrides: { WOLFPACK_DEV_DIR: projectRoot, WOLFPACK_PORT: "0" } });
});

test.afterAll(async () => {
  await server?.teardown();
  server = null;
  if (projectRoot) {
    rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  }
});

test("passive inspect is exact-ID, bounded, and leaves the active browser in control", async ({ browser }, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "iphone-se", "runs once with separate desktop controller and mobile inspector contexts");

  const create = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: SESSION_NAME }),
  });
  expect(create.status).toBe(200);

  const status = await fetch(`${server!.baseUrl}/api/session-control/status?session=${encodeURIComponent(SESSION_NAME)}`);
  expect(status.status).toBe(200);
  const statusBody = await status.json() as { readonly sessionId?: string };
  if (!statusBody.sessionId) throw new Error("session status omitted exact sessionId");
  const sessionId = statusBody.sessionId;

  let broker: BrokerClient | null = null;
  let controllerContext: BrowserContext | null = null;
  let inspectorContext: BrowserContext | null = null;

  try {
    broker = await connectBroker(server!.socketPath);
    controllerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    inspectorContext = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const controller = await controllerContext.newPage();
    const inspector = await inspectorContext.newPage();
    let inspectorPtyConnections = 0;
    inspector.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname === "/ws/pty") inspectorPtyConnections += 1;
    });

    await controller.goto(server!.baseUrl);
    await openSessionFromUi(controller, SESSION_NAME);
    await expect(controller.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5_000 });

    const firstMarker = `PASSIVE_INSPECT_FIRST_${Math.random().toString(36).slice(2)}`;
    await controller.locator("#desktop-terminal-container textarea").focus();
    await controller.keyboard.type(`echo ${firstMarker}`);
    await controller.keyboard.press("Enter");
    await waitForSnapshotText(broker, sessionId, firstMarker);
    const beforeInspection = await brokerSessionGeometry(broker, sessionId);

    await inspector.goto(server!.baseUrl);
    await expect(inspector.getByRole("button", { name: `Inspect ${SESSION_NAME}` })).toHaveCount(0);
    await openSessionFromUi(inspector, SESSION_NAME);
    const inspectorConflict = inspector.locator("#desktop-conflict-overlay");
    await expect(inspectorConflict).toBeVisible();
    const inspect = inspectorConflict.getByRole("button", { name: `Inspect ${SESSION_NAME}` });
    await expect(inspect).toBeVisible();
    const connectionsBeforeInspection = inspectorPtyConnections;
    await inspect.click();

    const dialog = inspector.getByRole("dialog", { name: `Inspect ${SESSION_NAME}` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(firstMarker);
    await expect(dialog).toContainText("Snapshot");
    await expect(dialog).toContainText(`${beforeInspection.cols} × ${beforeInspection.rows}`);
    expect(inspectorPtyConnections, "inspection must not mount another PTY websocket").toBe(connectionsBeforeInspection);
    expect(await brokerSessionGeometry(broker, sessionId)).toEqual(beforeInspection);

    await inspector.setViewportSize({ width: 390, height: 844 });
    const secondMarker = `PASSIVE_INSPECT_SECOND_${Math.random().toString(36).slice(2)}`;
    await controller.locator("#desktop-terminal-container textarea").focus();
    await controller.keyboard.type(`echo ${secondMarker}`);
    await controller.keyboard.press("Enter");
    await waitForSnapshotText(broker, sessionId, secondMarker);
    await expect(dialog).toContainText(secondMarker, { timeout: REFRESH_INTERVAL_MS + 3_000 });
    expect(await brokerSessionGeometry(broker, sessionId), "mobile inspector must not resize the broker PTY").toEqual(beforeInspection);
    expect(inspectorPtyConnections).toBe(connectionsBeforeInspection);

    const rowMarker = `PASSIVE_ROW_${Math.random().toString(36).slice(2)}`;
    await controller.locator("#desktop-terminal-container textarea").focus();
    await controller.keyboard.type(`printf '${rowMarker}%*s\\n' $((COLUMNS - ${rowMarker.length + 2})) '' | tr ' ' X`);
    await controller.keyboard.press("Enter");
    await waitForSnapshotText(broker, sessionId, rowMarker);
    const inspectorOutput = dialog.locator("#session-inspector-output");
    await expect(inspectorOutput).toContainText(rowMarker, { timeout: REFRESH_INTERVAL_MS + 3_000 });
    const outputLayout = await inspectorOutput.evaluate((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      horizontalOverflow: element.scrollWidth > element.clientWidth,
    }));
    expect(outputLayout).toEqual({ whiteSpace: "pre", horizontalOverflow: true });
    expect(await brokerSessionGeometry(broker, sessionId), "row inspection must not resize the broker PTY").toEqual(beforeInspection);

    await dialog.getByRole("button", { name: "Close inspection" }).click();
    await expect(dialog).toBeHidden();
    await expect(inspectorConflict).toBeVisible();
    await expect(inspect).toBeFocused();
    expect(inspectorPtyConnections).toBe(connectionsBeforeInspection);

    await inspectorConflict.getByRole("button", { name: "Take Control" }).click();
    await expect(inspector.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5_000 });
    await expect(controller.locator("#desktop-conflict-overlay")).toBeVisible({ timeout: 5_000 });
  } finally {
    broker?.close();
    await controllerContext?.close();
    await inspectorContext?.close();
  }
});

test("inspector modal blocks desktop shortcuts and restores focus on Escape", async ({ browser }, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "desktop", "desktop shortcut ownership runs once");

  const sessionName = `${SESSION_NAME}-shortcuts`;
  const create = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName }),
  });
  expect(create.status).toBe(200);
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const owner = await ownerContext.newPage();
    await owner.goto(server!.baseUrl);
    await openSessionFromUi(owner, sessionName);
    await expect(owner.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5_000 });

    const page = await context.newPage();
    await page.goto(server!.baseUrl);
    await openSessionFromUi(page, sessionName);
    const conflict = page.locator("#desktop-conflict-overlay");
    await expect(conflict).toBeVisible();
    const inspect = conflict.getByRole("button", { name: `Inspect ${sessionName}` });
    await inspect.click();
    const dialog = page.getByRole("dialog", { name: `Inspect ${sessionName}` });
    await expect(dialog).toBeVisible();
    await dialog.locator("#session-inspector-output").focus();
    const terminalViewClass = await page.locator("#terminal-view").getAttribute("class");
    const projectsViewClass = await page.locator("#projects-view").getAttribute("class");
    const sidebarClass = await page.locator("#desktop-sidebar").getAttribute("class");
    await page.evaluate(() => {
      document.body.dataset.inspectorShortcutEvents = "0";
      document.addEventListener("keydown", (event) => {
        if (event.metaKey || event.ctrlKey) document.body.dataset.inspectorShortcutEvents = String(Number(document.body.dataset.inspectorShortcutEvents) + 1);
      }, { capture: true });
      document.getElementById("sidebar-collapse-btn")?.addEventListener("click", () => { document.body.dataset.inspectorSidebarShortcut = "triggered"; });
    });
    for (const key of ["Meta+b", "Control+b", "Meta+t", "Control+t", "Meta+k", "Control+k", "Meta+ArrowDown"]) {
      await page.keyboard.press(key);
    }
    await expect(dialog).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-inspector-sidebar-shortcut", "triggered");
    await expect(page.locator("#terminal-view")).toHaveAttribute("class", terminalViewClass ?? "");
    await expect(page.locator("#projects-view")).toHaveAttribute("class", projectsViewClass ?? "");
    await expect(page.locator("#desktop-sidebar")).toHaveAttribute("class", sidebarClass ?? "");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(inspect).toBeFocused();
  } finally {
    await context.close();
    await ownerContext.close();
  }
});

test("snapshot endpoint accepts only the full pinned UUID", async ({}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "iphone-se", "real broker route contract runs once");

  const create = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: `${SESSION_NAME}-route` }),
  });
  expect(create.status).toBe(200);
  const status = await fetch(`${server!.baseUrl}/api/session-control/status?session=${encodeURIComponent(`${SESSION_NAME}-route`)}`);
  expect(status.status).toBe(200);
  const statusBody = await status.json() as { readonly sessionId?: string };
  if (!statusBody.sessionId) throw new Error("session status omitted exact sessionId");
  const sessionId = statusBody.sessionId;

  const valid = await fetch(`${server!.baseUrl}/api/session-control/snapshot?sessionId=${encodeURIComponent(sessionId)}`);
  expect(valid.status).toBe(200);
  expect(valid.headers.get("cache-control")).toBe("no-store");
  const snapshot = await valid.json() as {
    readonly sessionId?: string;
    readonly text?: string;
    readonly capturedAt?: string;
    readonly cols?: number;
    readonly rows?: number;
    readonly truncated?: boolean;
  };
  expect(snapshot).toMatchObject({
    sessionId,
    text: expect.any(String),
    capturedAt: expect.any(String),
    cols: expect.any(Number),
    rows: expect.any(Number),
    truncated: false,
  });

  const abbreviated = await fetch(`${server!.baseUrl}/api/session-control/snapshot?sessionId=${sessionId.slice(0, 8)}`);
  expect(abbreviated.status).toBe(400);
  const unknown = await fetch(`${server!.baseUrl}/api/session-control/snapshot?sessionId=00000000-0000-4000-8000-000000000000`);
  expect(unknown.status).toBe(404);
});

test("snapshot endpoint returns 410 for a reaped exact-ID tombstone", async ({}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "iphone-se", "real broker route contract runs once");

  const broker = await connectBroker(server!.socketPath);
  let sessionId: string | null = null;
  try {
    const created = await broker.request("create_session", {
      name: `${SESSION_NAME}-tombstone`,
      cwd: projectRoot!,
      command: ["/bin/sh", "-c", "exec sleep 30"],
      cols: 80,
      rows: 24,
    });
    const session = (created.payload as { readonly session?: { readonly id?: string } } | undefined)?.session;
    if (created.status !== "ok" || !session?.id) throw new Error("broker create_session omitted session id");
    sessionId = session.id;

    const killed = await broker.request("kill_session", { session_id: sessionId, signal: 1 });
    expect(killed.status).toBe("ok");
    await waitForDeadTombstone(broker, sessionId);

    const response = await fetch(`${server!.baseUrl}/api/session-control/snapshot?sessionId=${encodeURIComponent(sessionId)}`);
    expect(response.status).toBe(410);
  } finally {
    broker.close();
  }
});

test("snapshot endpoint preserves an empty visible screen as a successful snapshot", async ({}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "iphone-se", "real broker route contract runs once");

  const broker = await connectBroker(server!.socketPath);
  let sessionId: string | null = null;
  try {
    const created = await broker.request("create_session", {
      name: `${SESSION_NAME}-empty`,
      cwd: projectRoot!,
      command: ["/bin/sh", "-c", "exec sleep 30"],
      cols: 80,
      rows: 24,
    });
    expect(created.status).toBe("ok");
    const session = (created.payload as { readonly session?: { readonly id?: string } } | undefined)?.session;
    if (!session?.id) throw new Error("broker create_session omitted session id");
    sessionId = session.id;

    const response = await fetch(`${server!.baseUrl}/api/session-control/snapshot?sessionId=${encodeURIComponent(sessionId)}`);
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { readonly text?: string; readonly truncated?: boolean };
    expect(snapshot).toMatchObject({ text: "", truncated: false });
  } finally {
    if (sessionId) await broker.request("kill_session", { session_id: sessionId, signal: 1 });
    broker.close();
  }
});
