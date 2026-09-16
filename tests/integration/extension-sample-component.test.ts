import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

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

async function component() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return new URL(request.url).pathname === "/ui.js" ? new Response(Bun.file(join(root, "examples", "extensions", "agent-context", "dist", "ui.js")), { headers: { "content-type": "text/javascript" } }) : new Response("<main></main>", { headers: { "content-type": "text/html" } }); } });
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(server.url.toString());
  await page.evaluate(async () => { const module = await import("/ui.js"); let contribution: any; let publish: any; let releases = 0; module.default({ registerContextView(value: any) { contribution = value; }, registerTerminalLayout() {} }); const abort = new AbortController(); const storage = new Map<string, string>(); const controller = contribution.mount(document.querySelector("main"), { signal: abort.signal, scope: { installationId: "installation", sessionId: "11111111-1111-4111-8111-111111111111" }, selection: { selectedSessionId: null }, theme: {}, storage: { get: (key: string) => storage.get(key) ?? null, set: (key: string, value: string) => storage.set(key, value), remove: (key: string) => storage.delete(key) }, documents: { read: async () => null, subscribe(_id: string, listener: any) { publish = listener; listener(null, 0); return () => { releases++; }; } } }); (globalThis as any).__sample = { abort, controller, publish, releases: () => releases }; });
  return { page, async close() { await browser.close(); server.stop(true); } };
}

test("generated Agent Context component preserves focused drafts and ignores late stale revisions", async () => {
  const fixture = await component(); try { const { page } = fixture; expect(await page.locator("h2").textContent()).toContain("No context"); await page.locator("textarea").fill("draft"); await page.locator("textarea").evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(1, 4); (globalThis as any).editor = node; }); await page.evaluate(() => { const sample = (globalThis as any).__sample; const value = { schemaVersion: 1, goal: "<img src=x onerror=alert(1)>", planItems: [], decisions: [], blockers: [], nextSteps: [] }; sample.publish(value, 2); sample.publish({ ...value, goal: "stale" }, 1); }); expect(await page.locator("h2").textContent()).toBe("<img src=x onerror=alert(1)>"); expect(await page.locator("img").count()).toBe(0); expect(await page.locator("textarea").inputValue()).toBe("draft"); expect(await page.evaluate(() => { const node = (globalThis as any).editor; return [node === document.querySelector("textarea"), document.activeElement === node, node.selectionStart, node.selectionEnd]; })).toEqual([true, true, 1, 4]); } finally { await fixture.close(); }
}, 20_000);

test("generated Agent Context component releases once across abort, dispose, and late notification", async () => {
  const fixture = await component(); try { const result = await fixture.page.evaluate(() => { const sample = (globalThis as any).__sample; sample.abort.abort(); sample.controller.dispose(); sample.publish({ schemaVersion: 1, goal: "late", planItems: [], decisions: [], blockers: [], nextSteps: [] }, 1); return sample.releases(); }); expect(result).toBe(1); } finally { await fixture.close(); }
}, 20_000);
