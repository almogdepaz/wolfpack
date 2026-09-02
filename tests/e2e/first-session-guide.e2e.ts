import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

const FIRST_SESSION_GUIDE_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/first-session.md";
const SESSION_CONTROL_CREATE_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/session-control.md#create-a-top-level-session";
const SECURITY_AND_TRUST_URL =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/installation.md#security-and-trust";
const PEER_ORIGIN = "https://onboarding-peer.example.ts.net";
const PEER_INSTALLATION_ID = "4bdf501c-c3d8-4dda-b059-b5e963b93b0a";
const PEER_IDENTITY = `n-onboarding-peer:${PEER_INSTALLATION_ID}`;

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function routeEmptyLocalMachine(page: Page): Promise<void> {
  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ candidates: [] }),
  }));
  await page.route(`${server.baseUrl}/api/sessions`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: [] }),
  }));
}

async function expectSafeDocumentationLink(
  page: Page,
  name: string,
  href: string,
): Promise<void> {
  const link = page.getByRole("link", { name });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", href);
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = (await link.getAttribute("rel"))?.split(/\s+/) ?? [];
  expect(rel).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
}

async function expectPreInitSidebarState(page: Page, pinned: boolean): Promise<void> {
  const sidebar = page.locator("#desktop-sidebar");
  if (pinned) {
    await expect(sidebar).not.toHaveClass(/collapsed/);
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator("body")).toHaveClass(/sidebar-pinned/);
  } else {
    await expect(sidebar).toHaveClass(/collapsed/);
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("body")).not.toHaveClass(/sidebar-pinned/);
  }
  const layout = await page.evaluate(() => {
    const sidebarElement = document.getElementById("desktop-sidebar");
    const mainElement = document.getElementById("view-container");
    if (!sidebarElement || !mainElement) throw new Error("pre-init desktop layout is incomplete");
    const sidebarBox = sidebarElement.getBoundingClientRect();
    const mainBox = mainElement.getBoundingClientRect();
    return {
      mainLeft: mainBox.left,
      sidebarLeft: sidebarBox.left,
      sidebarRight: sidebarBox.right,
      sidebarWidth: sidebarBox.width,
    };
  });
  if (pinned) {
    expect(layout.sidebarLeft).toBe(0);
    expect(layout.sidebarWidth).toBeGreaterThan(0);
    expect(layout.sidebarRight).toBeLessThanOrEqual(layout.mainLeft);
  } else {
    expect(layout.sidebarRight).toBeLessThanOrEqual(layout.mainLeft);
  }
  expect(await page.evaluate(() => "state" in window)).toBe(false);
}

test("desktop cold load restores sidebar state before the deferred app bundle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop pre-init sidebar contract");
  await page.route("**/app.bundle.js*", (route) => route.abort());

  await page.goto(server.baseUrl);
  await expectPreInitSidebarState(page, true);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBeNull();
  await expect(page.locator("script:not([src])")).toHaveCount(0);
  const bootstrap = page.locator('script[src*="sidebar-bootstrap.js"]');
  await expect(bootstrap).toHaveCount(1);
  await expect(bootstrap).toHaveAttribute("src", /^\/sidebar-bootstrap\.js\?v=[0-9a-f]{16}$/);
  await expect(bootstrap).not.toHaveAttribute("nonce", /.+/);
  const bootstrapLoading = await bootstrap.evaluate((script) => {
    const element = script as HTMLScriptElement;
    return {
      async: element.async,
      defer: element.defer,
      origin: new URL(element.src).origin,
    };
  });
  expect(bootstrapLoading).toEqual({
    async: false,
    defer: false,
    origin: new URL(server.baseUrl).origin,
  });

  await page.evaluate(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.reload();
  await expectPreInitSidebarState(page, true);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBe("1");

  await page.evaluate(() => localStorage.setItem("wolfpack-sidebar-pinned", "0"));
  await page.reload();
  await expectPreInitSidebarState(page, false);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBe("0");

  await page.evaluate(() => {
    localStorage.removeItem("wolfpack-sidebar-pinned");
    localStorage.setItem("wolfpack-sidebar-collapsed", "1");
  });
  await page.reload();
  await expectPreInitSidebarState(page, false);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBeNull();
});

test("mobile cold load keeps the desktop sidebar collapsed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile pre-init sidebar contract");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/app.bundle.js*", (route) => route.abort());
  await page.goto(server.baseUrl);

  const sidebar = page.locator("#desktop-sidebar");
  await expect(sidebar).toHaveClass(/collapsed/);
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("body")).not.toHaveClass(/sidebar-pinned/);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBe("1");
});

test("authoritative empty sessions render one accessible first-session path that disappears after refresh", async ({ page }) => {
  let sessions: readonly Record<string, unknown>[] = [];
  let releaseSessionAuthority: () => void = () => {};
  const sessionAuthority = new Promise<void>((resolve) => {
    releaseSessionAuthority = resolve;
  });
  let holdNextSessionRefresh = false;
  let releaseHeldSessionRefresh: () => void = () => {};
  let heldSessionRefreshStarted: () => void = () => {};
  const heldSessionRefresh = new Promise<void>((resolve) => {
    releaseHeldSessionRefresh = resolve;
  });
  const heldSessionRefreshRequest = new Promise<void>((resolve) => {
    heldSessionRefreshStarted = resolve;
  });

  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{
        hostname: "offline-peer.example.ts.net",
        tailnetNodeId: "n-offline-peer",
        origin: "https://offline-peer.example.ts.net",
        online: false,
      }],
    }),
  }));
  await page.route(`${server.baseUrl}/api/sessions`, async (route) => {
    await sessionAuthority;
    const responseSessions = sessions;
    if (holdNextSessionRefresh) {
      holdNextSessionRefresh = false;
      heldSessionRefreshStarted();
      await heldSessionRefresh;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions: responseSessions }),
    });
  });
  await page.route(`${server.baseUrl}/api/projects`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ projects: ["onboarding-project"] }),
  }));

  await page.goto(server.baseUrl);
  const onboarding = page.getByRole("region", { name: "No sessions yet" });

  await expect(onboarding).toHaveCount(0);
  await expect(page.getByText("offline-peer.example.ts.net")).toHaveCount(0);
  releaseSessionAuthority();

  await expect(onboarding).toBeVisible();
  await expect(onboarding.getByRole("heading", { name: "No sessions yet" })).toBeVisible();
  await expect(onboarding).toContainText(
    "A session runs an installed agent or Shell inside a project on this machine.",
  );
  const steps = onboarding.getByRole("list", { name: "Session creation steps" });
  const stepItems = steps.getByRole("listitem");
  await expect(steps).toHaveJSProperty("tagName", "OL");
  await expect(stepItems).toHaveText([
    "Choose project",
    "Choose agent",
    "Open persistent terminal",
  ]);
  await expect(steps.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
  const stepPresentation = await stepItems.evaluateAll((items) => items.map((item) => {
    const style = getComputedStyle(item);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      listStyleType: style.listStyleType,
    };
  }));
  for (const presentation of stepPresentation) {
    expect.soft(presentation.listStyleType).toBe("decimal");
    expect.soft(presentation.borderWidth).toBe("0px");
    expect.soft(presentation.borderRadius).toBe("0px");
    expect.soft(presentation.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  }

  await expectSafeDocumentationLink(page, "First session guide", FIRST_SESSION_GUIDE_URL);
  await expectSafeDocumentationLink(page, "Use the CLI instead", SESSION_CONTROL_CREATE_URL);
  await expectSafeDocumentationLink(
    page,
    "Why Tailnet access is shell access",
    SECURITY_AND_TRUST_URL,
  );

  const primary = onboarding.getByRole("button", { name: "Create your first session" });
  await expect(primary).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) > 768) {
    await expect(page.getByRole("button", {
      name: /Create your first session|Start a session on this machine/,
    })).toHaveCount(1);
    await expect(page.locator("#sidebar-session-list").getByRole("button", {
      name: "Start a session on this machine",
    })).toHaveCount(0);
  }
  await primary.focus();
  await expect(primary).toBeFocused();
  const primaryStyle = await primary.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      height: rect.height,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(primaryStyle.height).toBeGreaterThanOrEqual(44);
  expect(primaryStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(primaryStyle.outlineWidth)).toBeGreaterThanOrEqual(2);

  const cardBox = await onboarding.boundingBox();
  const viewport = page.viewportSize();
  expect(cardBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(cardBox?.x).toBeGreaterThanOrEqual(0);
  expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => window.innerWidth),
  );
  const responsiveLayout = await onboarding.evaluate((element) => {
    const steps = element.querySelector(".zero-session-steps");
    const primaryButton = element.querySelector(".zero-session-primary");
    const links = element.querySelector(".zero-session-links");
    if (!steps || !primaryButton || !links) throw new Error("empty-state layout is incomplete");
    return {
      stepColumns: getComputedStyle(steps).gridTemplateColumns.split(" ").length,
      primaryWidth: primaryButton.getBoundingClientRect().width,
      cardWidth: element.getBoundingClientRect().width,
      linksDisplay: getComputedStyle(links).display,
    };
  });
  if ((viewport?.width ?? 0) <= 768) {
    expect(responsiveLayout.stepColumns).toBe(1);
    expect(responsiveLayout.primaryWidth).toBeGreaterThan(responsiveLayout.cardWidth * 0.75);
    expect(responsiveLayout.linksDisplay).toBe("grid");
    const mobileConnectors = await stepItems.evaluateAll((items) => items.slice(0, -1).map((item, index) => {
      const connector = getComputedStyle(item, "::after");
      const itemBox = item.getBoundingClientRect();
      const nextBox = items[index + 1]?.getBoundingClientRect();
      if (!nextBox) throw new Error("next session step is missing");
      return {
        content: connector.content,
        float: connector.float,
        left: Number.parseFloat(connector.left),
        position: connector.position,
        rowGap: nextBox.top - itemBox.bottom,
        top: Number.parseFloat(connector.top),
        itemHeight: itemBox.height,
      };
    }));
    for (const connector of mobileConnectors) {
      expect.soft(connector.content).toBe('"↓"');
      expect.soft(connector.float).toBe("none");
      expect.soft(connector.position).toBe("absolute");
      expect.soft(connector.left).toBeGreaterThanOrEqual(0);
      expect.soft(connector.left).toBeLessThanOrEqual(16);
      expect.soft(connector.top).toBeCloseTo(connector.itemHeight, 0);
      expect.soft(connector.rowGap).toBeGreaterThanOrEqual(20);
    }
  } else {
    expect(responsiveLayout.stepColumns).toBe(3);
  }

  const projectsRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/projects");
  await page.keyboard.press("Enter");
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);
  await expect(page.locator("#new-project-name")).toBeFocused();
  expect((await projectsRequest).url()).toBe(`${server.baseUrl}/api/projects`);

  await page.keyboard.press("Escape");
  await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
  holdNextSessionRefresh = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await heldSessionRefreshRequest;
  sessions = [{
    name: "first-created-session",
    lastLine: "$ pwd",
    triage: "idle",
    identity: {
      wolfpackSessionId: "first-created-session-id",
      wolfpackSessionName: "first-created-session",
    },
  }];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  releaseHeldSessionRefresh();

  await expect(onboarding).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create your first session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open first-created-session" }).filter({ visible: true }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: /Start a session on/ }).filter({ visible: true }).first()).toBeVisible();
});

test("remote empty-state activation preserves the verified machine selector", async ({ page }) => {
  const remoteProjectRequests: string[] = [];
  const localProjectRequests: string[] = [];

  await page.route("**/api/tailnet/v1/candidates", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{
        hostname: "onboarding-peer.example.ts.net",
        tailnetNodeId: "n-onboarding-peer",
        origin: PEER_ORIGIN,
        online: true,
      }],
    }),
  }));
  await page.route(`${server.baseUrl}/api/sessions`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      sessions: [{
        name: "local-existing",
        lastLine: "$ local",
        triage: "idle",
        identity: {
          wolfpackSessionId: "local-existing-id",
          wolfpackSessionName: "local-existing",
        },
      }],
    }),
  }));
  await page.route(`${server.baseUrl}/api/projects`, (route) => {
    localProjectRequests.push(route.request().url());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: [] }) });
  });
  await page.route(`${PEER_ORIGIN}/api/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Allow-Methods": "GET, POST",
        },
      });
      return;
    }

    let body: unknown;
    if (pathname === "/api/machine") {
      body = {
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-onboarding-peer",
          installationId: PEER_INSTALLATION_ID,
          displayName: "onboarding peer",
          origin: PEER_ORIGIN,
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      };
    } else if (pathname === "/api/sessions") {
      body = { sessions: [] };
    } else if (pathname === "/api/projects") {
      remoteProjectRequests.push(request.url());
      body = { projects: ["remote-onboarding-project"] };
    } else {
      await route.fulfill({ status: 404, body: "unexpected peer API" });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });
  });

  await page.goto(server.baseUrl);
  const peerGroup = page.locator(
    `#session-list .machine-group[data-machine="${PEER_IDENTITY}"]`,
  );
  const sidebarPeerGroup = page.locator(
    `#sidebar-session-list .machine-group[data-machine="${PEER_IDENTITY}"]`,
  );
  const desktop = (page.viewportSize()?.width ?? 0) > 768;
  const primary = desktop
    ? sidebarPeerGroup.getByRole("button", { name: "Start a session on onboarding peer" })
    : peerGroup.getByRole("button", { name: "Create your first session" });
  if (desktop) {
    await expect(page.getByRole("button", {
      name: /Create your first session|Start a session on onboarding peer/,
    })).toHaveCount(1);
    await expect(peerGroup.getByRole("region", { name: "No sessions yet" })).toBeHidden();
  } else {
    await expect(peerGroup.getByRole("region", { name: "No sessions yet" })).toBeVisible();
    await expect(peerGroup.getByRole("button", { name: "Start a session on onboarding peer" })).toHaveCount(0);
  }
  await expect(primary).toBeVisible();

  await primary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);
  await expect(page.getByRole("button", { name: "Open project remote-onboarding-project" })).toBeVisible();
  expect(remoteProjectRequests).toEqual([`${PEER_ORIGIN}/api/projects`]);
  expect(localProjectRequests).toEqual([]);
});

test("axe finds no serious or critical issues in the authoritative empty state", async ({ page }) => {
  await routeEmptyLocalMachine(page);
  await page.goto(server.baseUrl);
  await expect(page.getByRole("region", { name: "No sessions yet" })).toBeVisible();

  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude("canvas")
    .analyze();
  expect(result.violations.filter((violation) => (
    violation.impact === "serious" || violation.impact === "critical"
  ))).toEqual([]);
});
