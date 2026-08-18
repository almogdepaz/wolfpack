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

test.afterAll(() => {
  server?.close();
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

test("authoritative empty sessions render one accessible first-session path that disappears after refresh", async ({ page }) => {
  let sessions: readonly Record<string, unknown>[] = [];
  let releaseSessionAuthority: () => void = () => {};
  const sessionAuthority = new Promise<void>((resolve) => {
    releaseSessionAuthority = resolve;
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
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions }),
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
  await expect(onboarding.getByRole("listitem")).toHaveText([
    "Choose project",
    "Choose agent",
    "Open persistent terminal",
  ]);

  await expectSafeDocumentationLink(page, "First session guide", FIRST_SESSION_GUIDE_URL);
  await expectSafeDocumentationLink(page, "Use the CLI instead", SESSION_CONTROL_CREATE_URL);
  await expectSafeDocumentationLink(
    page,
    "Why Tailnet access is shell access",
    SECURITY_AND_TRUST_URL,
  );

  const primary = onboarding.getByRole("button", { name: "Create your first session" });
  await expect(primary).toBeVisible();
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
  } else {
    expect(responsiveLayout.stepColumns).toBe(3);
  }

  await page.keyboard.press("Enter");
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);
  await expect(page.locator("#new-project-name")).toBeFocused();
  expect(await page.evaluate(() => (
    window as typeof window & { state: { readonly projectMachine: string } }
  ).state.projectMachine)).toBe("");

  await page.keyboard.press("Escape");
  await expect(page.locator("#sessions-view")).toHaveClass(/visible/);
  sessions = [{
    name: "first-created-session",
    lastLine: "$ pwd",
    triage: "idle",
    identity: {
      wolfpackSessionId: "first-created-session-id",
      wolfpackSessionName: "first-created-session",
    },
  }];
  await page.evaluate(async () => {
    await (window as typeof window & {
      loadSessions: (forceAfterCurrent?: boolean) => Promise<void>;
    }).loadSessions(true);
  });

  await expect(onboarding).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create your first session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open first-created-session" })).toBeEnabled();
  await expect(page.locator("#session-list .machine-group").getByRole("button", {
    name: /Start a session on/,
  })).toBeVisible();
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
  const primary = peerGroup.getByRole("button", { name: "Create your first session" });
  await expect(peerGroup.getByRole("region", { name: "No sessions yet" })).toBeVisible();
  await expect(primary).toBeVisible();
  await expect(peerGroup.getByRole("button", { name: "Start a session on onboarding peer" })).toHaveCount(0);

  await primary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);
  await expect(page.getByRole("button", { name: "Open project remote-onboarding-project" })).toBeVisible();
  expect(await page.evaluate(() => (
    window as typeof window & { state: { readonly projectMachine: string } }
  ).state.projectMachine)).toBe(PEER_IDENTITY);
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
