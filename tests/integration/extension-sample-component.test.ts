import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const root = join(import.meta.dirname, "..", "..");

test("packed SDK supports strict outside-checkout TypeScript and Node ESM consumers", () => {
  const stage = mkdtempSync(join(tmpdir(), "wolfpack-sdk-consumer-"));
  try {
    const env = { ...process.env, HOME: join(stage, "home"), npm_config_cache: join(stage, "cache") }; mkdirSync(env.HOME, { recursive: true });
    const pack = Bun.spawnSync(["npm", "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", stage], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(pack.exitCode).toBe(0); const archive = JSON.parse(pack.stdout.toString())[0].filename;
    expect(Bun.spawnSync(["tar", "-xzf", join(stage, archive), "-C", stage]).exitCode).toBe(0); mkdirSync(join(stage, "node_modules")); symlinkSync("../package", join(stage, "node_modules", "wolfpack-bridge"));
    writeFileSync(join(stage, "consumer.mts"), `import { leadStackLayout, type ExtensionViewContext, type ContextViewContribution } from "wolfpack-bridge/extensions";
const view: ContextViewContribution = { id: "sample", title: "Sample", mount(container, context) { container.textContent = context.scope.sessionId; return { dispose() {} }; } };
function probe(context: ExtensionViewContext) { // @ts-expect-error auth is not public
 context.authToken; // @ts-expect-error UUID is a string
 const invalid: number = context.scope.sessionId; }
leadStackLayout({ panes: [{ id: "one" }], selectedPaneId: "one", viewport: { width: 1, height: 1 } });\n`);
    writeFileSync(join(stage, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2022", lib: ["ES2022", "DOM"], types: [], skipLibCheck: false }, files: ["consumer.mts"] }));
    const typed = Bun.spawnSync(["node", join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(stage, "tsconfig.json")], { cwd: stage, env, stdout: "pipe", stderr: "pipe" }); expect(typed.exitCode).toBe(0);
    const executed = Bun.spawnSync(["node", "--input-type=module", "-e", `import {leadStackLayout} from "wolfpack-bridge/extensions"; if (leadStackLayout({panes:[{id:"one"}],selectedPaneId:"one",viewport:{width:1,height:1}}).version !== 1) throw Error("bad SDK")`], { cwd: stage, env, stdout: "pipe", stderr: "pipe" }); expect(executed.exitCode).toBe(0);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}, 20_000);

type ComponentDependencies = { launch?: () => Promise<Browser>; onServer?: (url: string) => void; hostStyles?: boolean; sample?: "agent-context" | "changes" };

async function component({ launch = () => chromium.launch({ headless: true, ...(process.env.WOLFPACK_WIDGET_BRAVE ? { executablePath: process.env.WOLFPACK_WIDGET_BRAVE } : {}) }), onServer, hostStyles = false, sample = "agent-context" }: ComponentDependencies = {}) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ui.js") return new Response(Bun.file(join(root, "examples", "extensions", sample, "dist", "ui.js")), { headers: { "content-type": "text/javascript" } });
    if (path === "/styles.css") return new Response(Bun.file(join(root, "public", "styles.css")), { headers: { "content-type": "text/css" } });
    if (path === "/wolfpack-icon.svg") return new Response(Bun.file(join(root, "public", "wolfpack-icon.svg")), { headers: { "content-type": "image/svg+xml" } });
    return new Response(hostStyles ? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="workspace-context-region"><div id="workspace-context-container"><section class="widget-panel" style="width:100%;flex:1;max-height:none"><div class="widget-content"><main></main></div></section></div></div>' : "<main></main>", { headers: { "content-type": "text/html" } });
  } });
  let browser: Browser | undefined;
  try {
    onServer?.(server.url.toString());
    browser = await launch(); const browserContext = await browser.newContext(); const page = await browserContext.newPage(); await page.goto(server.url.toString());
    await page.evaluate(async () => {
      const asset = "/ui.js"; const module = await import(asset); let contribution: any; let publish: any; let releases = 0;
      module.default({ registerContextView(value: any) { contribution = value; }, registerTerminalLayout() {} });
      let abort = new AbortController(); const storage = new Map<string, string>();
      const git = { calls: 0, value: { state: "not-repository" } as any, fail: false, pending: false, signals: [] as AbortSignal[], releases: [] as Array<(value: any) => void> };
      (globalThis as any).__git = git;
      const mount = () => contribution.mount(document.querySelector("main"), {
        signal: abort.signal, scope: { installationId: "installation", sessionId: "11111111-1111-4111-8111-111111111111" },
        selection: { selectedSessionId: null }, theme: {},
        storage: { get: (key: string) => storage.get(key) ?? null, set: (key: string, value: string) => storage.set(key, value), remove: (key: string) => storage.delete(key) },
        documents: { read: async () => null, subscribe(_id: string, listener: any) { publish = listener; listener(null, 0); return () => { releases++; }; } },
        project: { gitStatus: async (signal: AbortSignal) => { git.calls++; git.signals.push(signal); if (git.fail) throw Error("unavailable"); return git.pending ? new Promise(resolve => git.releases.push(resolve)) : git.value; } },
      });
      let controller = mount();
      (globalThis as any).__sample = {
        get abort() { return abort; }, get controller() { return controller; },
        publish(value: unknown, revision: number) { publish(value, revision); }, storage, releases: () => releases,
        remount() { controller.dispose(); abort.abort(); abort = new AbortController(); controller = mount(); },
      };
    });
    return { page, async close() { await browser!.close(); server.stop(true); } };
  } catch (error) { await browser?.close(); server.stop(true); throw error; }
}

test("Changes component retains stale data honestly, pauses hidden reads and ignores late responses after disposal", async () => {
  const fixture = await component({ hostStyles: true, sample: "changes" });
  try {
    const { page } = fixture;
    await page.clock.install();
    await page.evaluate(() => (globalThis as any).__sample.controller.setVisible(true));
    await page.waitForFunction(() => document.querySelector('.wolfpack-changes [role="status"]')?.textContent === "Not a Git repository.");
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => (globalThis as any).__git.calls === 2);
    const ready = { state: "ready", branch: null, detached: true, staged: [], unstaged: [], untracked: [], truncated: false };
    await page.evaluate(value => { (globalThis as any).__git.value = value; }, ready);
    await page.getByRole("button", { name: "Refresh Git status" }).click();
    await page.waitForFunction(() => document.querySelector(".wolfpack-changes .branch")?.textContent === "Detached HEAD");
    expect(await page.getByRole("status").textContent()).toBe("Working tree clean.");
    await page.evaluate(value => { (globalThis as any).__git.value = { ...value, truncated: true, untracked: [{ path: "<img src=x>", status: "untracked" }] }; }, ready);
    await page.getByRole("button", { name: "Refresh Git status" }).click();
    await page.waitForFunction(() => document.querySelector('.wolfpack-changes [role="status"]')?.textContent?.includes("More changes"));
    expect(await page.locator(".wolfpack-changes img").count()).toBe(0);
    await page.locator(".wolfpack-changes .path").evaluate(node => { (globalThis as any).__retainedGitPath = node; });
    const lastSuccess = await page.locator(".wolfpack-changes .updated").getAttribute("datetime");
    await page.clock.fastForward(1000);
    await page.evaluate(() => { (globalThis as any).__git.fail = true; });
    await page.getByRole("button", { name: "Refresh Git status" }).click();
    await page.waitForFunction(() => document.querySelector('.wolfpack-changes [role="status"]')?.textContent?.includes("previous result"));
    expect(await page.locator(".wolfpack-changes .path").textContent()).toBe("<img src=x>");
    expect(await page.locator(".wolfpack-changes .path").evaluate(node => node === (globalThis as any).__retainedGitPath)).toBe(true);
    expect(await page.locator(".wolfpack-changes .updated").getAttribute("datetime")).toBe(lastSuccess);
    expect(await page.locator(".wolfpack-changes").getAttribute("data-stale")).toBe("true");
    const accessibility = await new AxeBuilder({ page }).include(".wolfpack-changes").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    await page.evaluate(() => { const git = (globalThis as any).__git; git.fail = false; git.pending = true; });
    await page.getByRole("button", { name: "Refresh Git status" }).click();
    await page.waitForFunction(() => (globalThis as any).__git.releases.length === 1);
    const calls = await page.evaluate(() => (globalThis as any).__git.calls);
    await page.clock.fastForward(15000); expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(calls);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(await page.evaluate(() => (globalThis as any).__git.signals.at(-1).aborted)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.fastForward(20000); expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(calls);
    await page.evaluate(value => {
      const git = (globalThis as any).__git; git.pending = false; git.value = { ...value, branch: "current", detached: false };
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange"));
    }, ready);
    await page.waitForFunction(() => document.querySelector(".wolfpack-changes .branch")?.textContent === "current");
    await page.evaluate(value => (globalThis as any).__git.releases[0]({ ...value, branch: "obsolete", detached: false }), ready);
    expect(await page.locator(".wolfpack-changes .branch").textContent()).toBe("current");
    const beforeDispose = await page.evaluate(() => { (globalThis as any).__sample.abort.abort(); return (globalThis as any).__git.calls; });
    await page.clock.fastForward(20000);
    expect(await page.locator(".wolfpack-changes").count()).toBe(0);
    expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(beforeDispose);
  } finally { await fixture.close(); }
}, 20_000);

test("Changes refreshes on browser focus, coalesces reads and ignores focus while hidden or disposed", async () => {
  const fixture = await component({ hostStyles: true, sample: "changes" });
  try {
    const { page } = fixture; await page.clock.install();
    await page.evaluate(() => (globalThis as any).__sample.controller.setVisible(true));
    await page.waitForFunction(() => document.querySelector('.wolfpack-changes [role="status"]')?.textContent === "Not a Git repository.");
    await page.evaluate(() => {
      (globalThis as any).__git.value = { state: "ready", branch: "automatic", detached: false, staged: [], unstaged: [], untracked: [], truncated: false };
      window.dispatchEvent(new Event("focus"));
    });
    expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(2);
    await page.waitForFunction(() => document.querySelector(".wolfpack-changes .branch")?.textContent === "automatic");
    await page.evaluate(() => {
      (globalThis as any).__git.pending = true;
      window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await page.getByRole("button", { name: "Refresh Git status" }).getAttribute("aria-busy")).toBe("true");
    await page.clock.fastForward(15000);
    expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(3);
    await page.evaluate(() => { (globalThis as any).__sample.controller.setVisible(false); window.dispatchEvent(new Event("focus")); });
    expect(await page.evaluate(() => (globalThis as any).__git.signals.at(-1).aborted)).toBe(true);
    expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(3);
    await page.evaluate(() => { (globalThis as any).__git.pending = false; (globalThis as any).__sample.controller.setVisible(true); });
    expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(4);
    await page.evaluate(() => { (globalThis as any).__sample.abort.abort(); window.dispatchEvent(new Event("focus")); });
    await page.clock.fastForward(15000);
    expect(await page.evaluate(() => (globalThis as any).__git.calls)).toBe(4);
  } finally { await fixture.close(); }
}, 20_000);

test("Changes uses unique counts, literal filename hierarchy and stable keyboard disclosures across automatic refresh", async () => {
  const fixture = await component({ hostStyles: true, sample: "changes" });
  try {
    const { page } = fixture; await page.clock.install();
    await page.evaluate(() => {
      (globalThis as any).__git.value = { state: "ready", branch: "feature/changes-refinement-with-a-long-branch-name", detached: false, truncated: false,
        staged: [{ path: "src/widgets/changes.ts", status: "modified" }, { path: "src/components/new.ts", previousPath: "src/old.ts", status: "renamed" }],
        unstaged: [{ path: "src/widgets/changes.ts", status: "modified" }, { path: "src/obsolete.ts", status: "deleted" }, { path: "conflict.ts", status: "unmerged" }],
        untracked: [{ path: "new/<img src=x>.ts", status: "untracked" }, { path: `some/very/long/directory/${"x".repeat(200)}.ts`, status: "untracked" }, { path: "generated/", status: "untracked" }],
      };
      (globalThis as any).__sample.controller.setVisible(true);
    });
    await page.waitForFunction(() => document.querySelector(".wolfpack-changes .branch")?.textContent?.startsWith("feature/"));
    expect(await page.locator(".wolfpack-changes .change-count").count()).toBe(1);
    expect(await page.locator(".wolfpack-changes .change-count").textContent()).toBe("7 changed files");
    expect(await page.getByRole("list", { name: "Staged files", exact: true }).locator(".file-name").first().textContent()).toBe("changes.ts");
    expect(await page.getByRole("list", { name: "Staged files", exact: true }).locator(".directory").first().textContent()).toBe("src/widgets");
    expect(await page.locator('.kind[aria-label="Modified"]').first().textContent()).toBe("M");
    expect(await page.locator('.kind[aria-label="Unmerged"]').textContent()).toBe("!");
    expect(await page.locator('.path[title="src/widgets/changes.ts"]').count()).toBe(2);
    expect(await page.locator('.previous-path').textContent()).toBe("from src/old.ts");
    expect(await page.locator(".wolfpack-changes img").count()).toBe(0);
    const summary = page.locator('[data-group="staged"] summary');
    await summary.focus(); await summary.press("Space");
    expect(await page.locator('[data-group="staged"]').evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);
    await summary.evaluate(node => { (globalThis as any).__gitSummary = node; });
    await page.evaluate(() => { (globalThis as any).__git.value.untracked.push({ path: "auto.ts", status: "untracked" }); });
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.querySelector(".wolfpack-changes .change-count")?.textContent === "8 changed files");
    expect(await summary.evaluate(node => node === (globalThis as any).__gitSummary && node === document.activeElement)).toBe(true);
    expect(await page.locator('[data-group="staged"]').evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);
    await summary.press("Enter");
    expect(await page.locator('[data-group="staged"]').evaluate((node: HTMLDetailsElement) => node.open)).toBe(true);
    for (const width of [320, 900]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.locator(".wolfpack-changes").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const refresh = await page.getByRole("button", { name: "Refresh Git status" }).boundingBox();
      expect(refresh!.height).toBeGreaterThanOrEqual(width === 320 ? 44 : 32);
      const accessibility = await new AxeBuilder({ page }).include(".wolfpack-changes").withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(accessibility.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
      if (process.env.WOLFPACK_WIDGET_ARTIFACTS) {
        mkdirSync(process.env.WOLFPACK_WIDGET_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: join(process.env.WOLFPACK_WIDGET_ARTIFACTS, `changes-${width}.png`), fullPage: true, animations: "disabled" });
      }
    }
    // If the focused group becomes empty, keep keyboard focus on an available widget control.
    await summary.focus();
    await page.evaluate(() => { (globalThis as any).__git.value.staged = []; window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => (document.querySelector('[data-group="staged"]') as HTMLElement).hidden);
    expect(await page.getByRole("button", { name: "Refresh Git status" }).evaluate(node => node === document.activeElement)).toBe(true);
  } finally { await fixture.close(); }
}, 20_000);

test("component fixture releases server and partial browser after later startup rejection", async () => {
  let serverUrl = ""; let closes = 0;
  const partial = { close: async () => { closes++; }, newContext: async () => ({ newPage: async () => { throw new Error("new page failed"); } }) } as unknown as Browser;
  await expect(component({ launch: async () => partial, onServer: (url) => { serverUrl = url; } })).rejects.toThrow("new page failed");
  expect(closes).toBe(1);
  await expect(fetch(serverUrl)).rejects.toThrow();
});

test("empty Agent Context explains skill publication for the exact scope and hides guidance after publication", async () => {
  const fixture = await component();
  try {
    const { page } = fixture;
    const guidance = page.getByText(/Ask your agent to publish a brief for this session/);
    expect(await guidance.isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Copy request" }).isVisible()).toBe(true);
    await page.getByText("Session details", { exact: true }).click();
    expect(await page.locator(".wac-session-id").textContent()).toBe("11111111-1111-4111-8111-111111111111");
    await page.evaluate(() => (globalThis as any).__sample.publish({ schemaVersion: 1, goal: "A real document", planItems: [], decisions: [], blockers: [], nextSteps: [] }, 1));
    expect(await guidance.isVisible()).toBe(false);
  } finally { await fixture.close(); }
});

test("generated Agent Context component preserves focused drafts and ignores late stale revisions", async () => {
  const fixture = await component(); try { const { page } = fixture; expect(await page.locator("h2").textContent()).toContain("No context"); await page.getByText("Local draft", { exact: true }).click(); await page.locator("textarea").fill("draft"); await page.locator("textarea").evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(1, 4); (globalThis as any).editor = node; }); await page.evaluate(() => { const sample = (globalThis as any).__sample; const value = { schemaVersion: 1, goal: "<img src=x onerror=alert(1)>", planItems: [], decisions: [], blockers: [], nextSteps: [] }; sample.publish(value, 2); sample.publish({ ...value, goal: "stale" }, 1); }); expect(await page.locator("h2").textContent()).toBe("<img src=x onerror=alert(1)>"); expect(await page.locator("img").count()).toBe(0); expect(await page.locator("textarea").inputValue()).toBe("draft"); expect(await page.evaluate(() => { const node = (globalThis as any).editor; return [node === document.querySelector("textarea"), document.activeElement === node, node.selectionStart, node.selectionEnd]; })).toEqual([true, true, 1, 4]); } finally { await fixture.close(); }
}, 20_000);

const richDocument = {
  schemaVersion: 1, goal: "Make Agent Context easier to scan",
  planItems: [
    { id: "inspect", text: "Inspect the changes\n\nReview spacing, hierarchy and interactions.", status: "in_progress" },
    { id: "ship", text: "Apply the update\n\nKeep the live terminal and its session unchanged.", status: "pending" },
  ],
  decisions: ["Native disclosures\n\nKeyboard, touch and pointer users can expand each item independently."],
  blockers: ["Feedback needed\n\nWaiting for the design review before claiming visual acceptance."],
  nextSteps: ["Review the narrow sidebar\n\nCheck long headlines and expanded descriptions."],
};

test("bullet disclosures preserve keyboard focus and independent expansion across updates and reordering", async () => {
  const fixture = await component({ hostStyles: true });
  try {
    const { page } = fixture;
    await page.evaluate((value) => (globalThis as any).__sample.publish(value, 1), richDocument);
    const inspect = page.locator(".wac-item summary").filter({ hasText: "Inspect the changes" });
    const ship = page.locator(".wac-item summary").filter({ hasText: "Apply the update" });
    expect(await inspect.locator("..").getAttribute("open")).toBeNull();
    await inspect.focus(); await page.keyboard.press("Enter");
    expect(await page.getByText("Review spacing, hierarchy and interactions.", { exact: true }).isVisible()).toBe(true);
    expect(await ship.locator("..").getAttribute("open")).toBeNull();
    await page.waitForFunction(() => (globalThis as any).__sample.storage.get('bullet-open:["plan","inspect",0]') === "true");
    await inspect.evaluate((element) => { (globalThis as any).__focusedSummary = element; });
    await page.evaluate((value) => {
      const sample = (globalThis as any).__sample;
      sample.publish({ ...value, planItems: [value.planItems[1], { ...value.planItems[0], text: "Inspect the revised changes\n\nNew supporting detail." }] }, 2);
      sample.publish(value, 1);
    }, richDocument);
    expect(await page.evaluate(() => document.activeElement === (globalThis as any).__focusedSummary)).toBe(true);
    expect(await page.getByText("New supporting detail.", { exact: true }).isVisible()).toBe(true);
    await page.keyboard.press("Space");
    expect(await page.getByText("New supporting detail.", { exact: true }).isVisible()).toBe(false);
    expect(await page.locator(".wac-item").count()).toBe(5);
    await page.evaluate(() => (globalThis as any).__sample.controller.setVisible(false));
    expect(await page.locator(".wolfpack-agent-context").isVisible()).toBe(false);
    await page.evaluate(() => (globalThis as any).__sample.controller.setVisible(true));
    expect(await page.locator(".wolfpack-agent-context").isVisible()).toBe(true);
  } finally { await fixture.close(); }
}, 20_000);

test("disclosure preferences and local draft survive remount without publishing or opening empty expanders", async () => {
  const fixture = await component();
  try {
    const { page } = fixture;
    await page.evaluate((value) => (globalThis as any).__sample.publish(value, 1), richDocument);
    await page.getByText("Native disclosures", { exact: true }).click();
    await page.getByText("Local draft", { exact: true }).click();
    await page.getByRole("textbox", { name: "Local draft", exact: true }).fill("Keep this local");
    await page.waitForFunction(() => (globalThis as any).__sample.storage.get('bullet-open:["decisions","Native disclosures",0]') === "true");
    await page.evaluate((value) => { const sample = (globalThis as any).__sample; sample.remount(); sample.publish(value, 1); }, richDocument);
    expect(await page.getByRole("textbox", { name: "Local draft", exact: true }).inputValue()).toBe("Keep this local");
    expect(await page.getByText(richDocument.decisions[0].split("\n\n")[1]!, { exact: true }).isVisible()).toBe(true);
    await page.evaluate(() => (globalThis as any).__sample.publish({ schemaVersion: 1, goal: "Legacy", planItems: [{ id: "plain", text: "Existing plan", status: "complete" }], decisions: ["An existing decision"], blockers: [], nextSteps: [] }, 2));
    expect(await page.getByText("An existing decision", { exact: true }).isVisible()).toBe(true);
    expect(await page.locator(".wac-item details:not([hidden])").count()).toBe(0);
    expect(await page.getByText("No blockers reported", { exact: false }).isVisible()).toBe(true);
    expect(await page.getByRole("region", { name: "Blockers", exact: true }).isVisible()).toBe(false);
  } finally { await fixture.close(); }
}, 20_000);

test("all plan states stay readable, blockers are prominent, and expanded hostile text stays inert", async () => {
  const fixture = await component({ hostStyles: true });
  try {
    const { page } = fixture;
    const statuses = ["pending", "in_progress", "complete", "blocked"];
    await page.evaluate((value) => (globalThis as any).__sample.publish(value, 1), { ...richDocument, planItems: statuses.map((status) => ({ id: status, text: `${status}\n\n<img src=x onerror=alert(1)>\n<script>bad()</script>`, status })) });
    for (const label of ["Pending", "In progress", "Complete", "Blocked"]) expect(await page.locator(".wac-status").getByText(label, { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("1 of 4 items complete, reported by the agent");
    expect(await page.getByText(richDocument.blockers[0].split("\n\n")[1]!, { exact: true }).isVisible()).toBe(true);
    const plan = page.getByRole("region", { name: "Plan", exact: true });
    await plan.locator(".wac-item summary").first().click();
    expect(await plan.locator(".wac-detail").first().textContent()).toContain("<img src=x onerror=alert(1)>");
    expect(await page.locator(".wolfpack-agent-context img, .wolfpack-agent-context script").count()).toBe(0);
    await page.evaluate(() => (globalThis as any).__sample.publish({ invalid: true }, 2));
    expect(await page.getByRole("heading", { name: "Context unavailable" }).isVisible()).toBe(true);
    expect(await page.locator(".wac-content").isVisible()).toBe(false);
    await page.evaluate((value) => (globalThis as any).__sample.publish(value, 3), richDocument);
    expect(await page.getByRole("heading", { name: richDocument.goal }).isVisible()).toBe(true);
  } finally { await fixture.close(); }
}, 20_000);

test("copy and draft storage failures are explicit and do not lose draft input", async () => {
  const fixture = await component();
  try {
    const { page } = fixture;
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
    await page.getByRole("button", { name: "Copy request" }).click();
    expect(await page.getByRole("status").textContent()).toContain("Could not copy");
    await page.getByText("Local draft", { exact: true }).click();
    await page.evaluate(() => { (globalThis as any).__sample.storage.set = () => { throw new Error("quota"); }; });
    await page.getByRole("textbox", { name: "Local draft", exact: true }).fill("Unsaved but retained");
    expect(await page.getByText(/Could not save in this browser/).isVisible()).toBe(true);
    expect(await page.getByRole("textbox", { name: "Local draft", exact: true }).inputValue()).toBe("Unsaved but retained");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (globalThis as any).__copied = text; } } }));
    await page.getByRole("button", { name: "Copy request" }).click();
    expect(await page.evaluate(() => (globalThis as any).__copied)).toContain("Update this session's context");
  } finally { await fixture.close(); }
}, 20_000);

test("widget has no horizontal overflow or serious accessibility violations with long expanded content", async () => {
  const fixture = await component({ hostStyles: true });
  try {
    const { page } = fixture;
    await page.evaluate((value) => (globalThis as any).__sample.publish(value, 1), { ...richDocument, decisions: ["A".repeat(240) + "\n\nhttps://example.test/" + "long".repeat(1000)] });
    await page.locator(".wac-item summary").filter({ hasText: "A".repeat(240) }).click();
    for (const width of [220, 320, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.locator(".wolfpack-agent-context").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.setViewportSize({ width: 320, height: 1000 });
    const results = await new AxeBuilder({ page }).include(".wolfpack-agent-context").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.locator(".wac-chevron").first().evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
  } finally { await fixture.close(); }
}, 20_000);

test("Agent Context visual fixture uses host styles at narrow, sidebar and full-view widths", async () => {
  const fixture = await component({ hostStyles: true });
  try {
    const document = process.env.WOLFPACK_WIDGET_DOCUMENT
      ? JSON.parse(readFileSync(process.env.WOLFPACK_WIDGET_DOCUMENT, "utf8")).document
      : { schemaVersion: 1, goal: "Make the session brief easier to scan", planItems: [{ id: "design", text: "Refine the widget\n\nSeparate each item clearly. Keep its headline and status visible, with supporting detail one click away.", status: "in_progress" }], decisions: ["Progressive disclosure\n\nUse native keyboard-accessible disclosures. Keep expanded items open when a new revision arrives."], blockers: [], nextSteps: ["Review the new design\n\nCheck the narrow sidebar and full context view, then verify keyboard interaction."] };
    await fixture.page.evaluate((value) => (globalThis as any).__sample.publish(value, 1), document);
    for (const width of [220, 320, 960]) {
      await fixture.page.setViewportSize({ width, height: 1000 });
      expect(await fixture.page.locator("h2").textContent()).toBe(document.goal);
      expect(await fixture.page.locator(".widget-content").evaluate(el => getComputedStyle(el).padding)).toBe("16px");
      expect(await fixture.page.locator(".wac-goal").evaluate(el => getComputedStyle(el).borderRadius)).toBe("9px");
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.WOLFPACK_WIDGET_ARTIFACTS) {
        mkdirSync(process.env.WOLFPACK_WIDGET_ARTIFACTS, { recursive: true });
        await fixture.page.screenshot({ path: join(process.env.WOLFPACK_WIDGET_ARTIFACTS, `widget-${width}.png`), fullPage: true });
      }
    }
    if (process.env.WOLFPACK_WIDGET_ARTIFACTS && await fixture.page.locator(".wac-item details:not([hidden]) summary").count()) {
      await fixture.page.setViewportSize({ width: 320, height: 1000 });
      await fixture.page.locator(".wac-item details:not([hidden]) summary").first().click();
      await fixture.page.screenshot({ path: join(process.env.WOLFPACK_WIDGET_ARTIFACTS, "widget-expanded-320.png"), fullPage: true, animations: "disabled" });
    }
  } finally { await fixture.close(); }
}, 20_000);

test("generated Agent Context component releases once across abort, dispose, and late notification", async () => {
  const fixture = await component(); try { const result = await fixture.page.evaluate(() => { const sample = (globalThis as any).__sample; sample.abort.abort(); sample.controller.dispose(); sample.publish({ schemaVersion: 1, goal: "late", planItems: [], decisions: [], blockers: [], nextSteps: [] }, 1); return sample.releases(); }); expect(result).toBe(1); } finally { await fixture.close(); }
}, 20_000);
