import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page, Response, Route } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  HOMEPAGE_DIAGNOSTIC_DIRECTORY,
  SITE_ROOT,
  homepageScreenshotPath,
} from "../homepage-quality-helpers.ts";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

const HOMEPAGE_PREFIX = "/homepage/";
const BUNX_COMMAND = "bunx wolfpack-bridge@latest";
const LOCAL_FCP_BUDGET_MS = 5_000;
const FIRST_PARTY_TRANSFER_BUDGET_BYTES = 1_000_000;
const HAVE_METADATA_READY_STATE = 1;
const GOOGLE_FONTS_URL = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//;
const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};
const FALLBACK_CONTENT_TYPE = "application/octet-stream";
const REAL_SITE_ROOT = realpathSync(SITE_ROOT);

interface ResolvedSiteFile {
  readonly absolutePath: string;
}

let server: TestServer;
const browserErrors = new WeakMap<Page, string[]>();
const siteResponses = new WeakMap<Page, Response[]>();

function isContainedFilePath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function resolveSiteFile(requestUrl: URL): ResolvedSiteFile | null {
  const encodedPath = requestUrl.pathname === HOMEPAGE_PREFIX
    ? "index.html"
    : requestUrl.pathname.slice(HOMEPAGE_PREFIX.length);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  const candidatePath = resolve(SITE_ROOT, decodedPath);
  if (!isContainedFilePath(SITE_ROOT, candidatePath)) return null;

  try {
    const absolutePath = realpathSync(candidatePath);
    if (!isContainedFilePath(REAL_SITE_ROOT, absolutePath)) return null;
    if (!statSync(absolutePath).isFile()) return null;
    return { absolutePath };
  } catch {
    return null;
  }
}

async function fulfillHomepageRoute(route: Route): Promise<void> {
  const requestUrl = new URL(route.request().url());
  const siteFile = resolveSiteFile(requestUrl);
  if (!siteFile) {
    await route.fulfill({ status: 404, body: "Not found" });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: CONTENT_TYPES_BY_EXTENSION[extname(siteFile.absolutePath).toLowerCase()]
      ?? FALLBACK_CONTENT_TYPE,
    body: readFileSync(siteFile.absolutePath),
  });
}

async function openHomepage(page: Page): Promise<void> {
  await page.route(`${server.baseUrl}${HOMEPAGE_PREFIX}**`, fulfillHomepageRoute);
  await page.route(GOOGLE_FONTS_URL, async (route) => {
    if (new URL(route.request().url()).hostname === "fonts.googleapis.com") {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }
    await route.abort();
  });
  const response = await page.goto(`${server.baseUrl}${HOMEPAGE_PREFIX}`);
  if (!response) throw new Error("homepage navigation returned no response");
}

test.describe.configure({ timeout: 60_000 });

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const responses: Response[] = [];
  browserErrors.set(page, errors);
  siteResponses.set(page, responses);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith(HOMEPAGE_PREFIX)) {
      responses.push(response);
    }
  });
  await openHomepage(page);
});

test("install section is visible, keyboard reachable, responsive, and accessible", async ({ page }) => {
  const installRegion = page.getByRole("region", { name: "Install Wolfpack" });
  await expect(installRegion).toBeVisible();

  const heroCta = page.locator(".hero .install-cta");
  await expect(heroCta).toHaveAttribute("href", "#install");

  await expect(page.locator(".nav nav")).toBeVisible();
  await expect(page.locator(".nav nav").getByRole("link", { name: "How it works" })).toBeVisible();
  await expect(page.locator(".nav nav").getByRole("link", { name: "Install" })).toBeVisible();
  await expect(page.locator(".nav nav").getByRole("link", { name: "Privacy" })).toBeVisible();

  await heroCta.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#install$/);
  await expect(installRegion).toBeInViewport();

  const installerDisclosure = page.getByText("What the installer changes", { exact: true });
  await installerDisclosure.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("details.installer-changes")).toHaveAttribute("open", "");

  const copyButton = page.locator("[data-copy-command]").first();
  await copyButton.focus();
  const focusOutline = await copyButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusOutline.style).not.toBe("none");
  expect(focusOutline.width).toBeGreaterThanOrEqual(2);

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});

test("captures a full-page diagnostic and stays within generous local budgets", async ({ page }, testInfo) => {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("#install-title")).toBeVisible();
  for (const image of await page.locator("img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(
      (element) => (element as HTMLImageElement).naturalWidth,
    )).toBeGreaterThan(0);
  }
  for (const video of await page.locator("video").all()) {
    await video.scrollIntoViewIfNeeded();
    await expect.poll(() => video.evaluate(
      (element) => (element as HTMLVideoElement).readyState,
    )).toBeGreaterThanOrEqual(HAVE_METADATA_READY_STATE);
  }
  const dependencyUrls = await page.locator(
    'link[rel="icon"][href], link[rel="stylesheet"][href], script[src], source[src], img[src]',
  ).evaluateAll((elements) => elements.map((element) =>
    (element as HTMLLinkElement).href || (element as HTMLScriptElement).src
  ));
  const expectedPaths = new Set(dependencyUrls
    .map((url) => new URL(url))
    .filter((url) => url.origin === server.baseUrl)
    .map((url) => url.pathname));
  const successfulPaths = new Set((siteResponses.get(page) ?? [])
    .filter((response) => response.status() === 200)
    .map((response) => new URL(response.url()).pathname));
  expect(successfulPaths).toContain(HOMEPAGE_PREFIX);
  for (const expectedPath of expectedPaths) expect(successfulPaths).toContain(expectedPath);
  expect(new Set([...expectedPaths].map((path) => extname(path)))).toEqual(
    new Set([".css", ".js", ".mp4", ".png", ".svg", ".webp"]),
  );

  const diagnosticPath = homepageScreenshotPath(testInfo.project.name);
  mkdirSync(HOMEPAGE_DIAGNOSTIC_DIRECTORY, { recursive: true });
  await page.screenshot({ fullPage: true, path: diagnosticPath });
  expect(existsSync(diagnosticPath)).toBe(true);
  expect(statSync(diagnosticPath).size).toBeGreaterThan(0);

  await expect.poll(() => page.evaluate(() =>
    performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null
  )).not.toBeNull();
  const metrics = await page.evaluate((homepagePrefix) => {
    const entryBytes = (entry: PerformanceResourceTiming | PerformanceNavigationTiming): number =>
      entry.transferSize || entry.encodedBodySize || entry.decodedBodySize;
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => new URL(entry.name).pathname.startsWith(homepagePrefix));
    return {
      firstContentfulPaintMs:
        performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? Number.POSITIVE_INFINITY,
      firstPartyTransferBytes: entryBytes(navigation) +
        resources.reduce((total, entry) => total + entryBytes(entry), 0),
    };
  }, HOMEPAGE_PREFIX);
  await testInfo.attach("local-performance-diagnostic", {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: "application/json",
  });

  expect(metrics.firstContentfulPaintMs).toBeLessThanOrEqual(LOCAL_FCP_BUDGET_MS);
  expect(metrics.firstPartyTransferBytes).toBeGreaterThan(0);
  expect(metrics.firstPartyTransferBytes).toBeLessThanOrEqual(
    FIRST_PARTY_TRANSFER_BUDGET_BYTES,
  );

  expect(browserErrors.get(page)).toEqual([]);
});

test("aborted Google Fonts preserve content through declared local fallbacks", async ({ page }) => {
  await page.unroute(GOOGLE_FONTS_URL);
  await page.route(GOOGLE_FONTS_URL, (route) => route.abort());
  await page.reload({ waitUntil: "load" });

  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("[data-install-command]").first()).toBeVisible();
  const fontFamilies = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    command: getComputedStyle(document.querySelector("[data-install-command]") as Element).fontFamily,
  }));
  expect(fontFamilies.body).toContain("Manrope");
  expect(fontFamilies.body).toContain("sans-serif");
  expect(fontFamilies.command).toContain("DM Mono");
  expect(fontFamilies.command).toContain("monospace");
});

test("complete homepage has no serious or critical accessibility violations", async ({ page }) => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact || ""))).toEqual([]);
});

test("copy success writes and announces the visible command", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.baseUrl });

  await page.getByRole("button", { name: "Copy Bunx command" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Copied Bunx command." })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(BUNX_COMMAND);
});

test("rejected and unavailable clipboard paths announce manual selection without false success", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
  });

  await page.getByRole("button", { name: "Copy npm command" }).click();
  const npmStatus = page.locator("#copy-status-npm");
  await expect(npmStatus).toHaveText("Copy failed. Select the visible command and copy it manually.");
  await expect(npmStatus).not.toContainText("Copied");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });
  await page.getByRole("button", { name: "Copy persistent CLI command" }).click();
  const persistentStatus = page.locator("#copy-status-persistent");
  await expect(persistentStatus).toHaveText("Copy failed. Select the visible command and copy it manually.");
  await expect(persistentStatus).not.toContainText("Copied");
});
