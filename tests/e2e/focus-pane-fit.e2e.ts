import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "embedded pane geometry"); });

for (const width of [1440, 1280]) for (const entry of ["dashboard", "cached first paint"] as const) test(`pane first fit: ${entry} at ${width} never paints hidden columns or attaches at an obsolete size`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "1");
    localStorage.setItem("wolfpackDebug", "1");
  });
  // The cached entry opens the same native control as soon as its first paint
  // exists, before the fresh focus response supplies the pane's target.
  if (entry === "cached first paint") {
    await page.goto(server.baseUrl);
    await expect(page.locator("#dashboard-focus .focus-next")).toBeVisible();
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const button = document.querySelector<HTMLButtonElement>("#dashboard-focus [aria-label='Open assistant page']");
        if (button) { observer.disconnect(); button.click(); }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
  }
  await page.addInitScript(() => {
    const state = window as unknown as { paneFit: { done: boolean; frames: { t: number; mount: number; canvas: number; right: number; mountRight: number; height: number }[] } };
    state.paneFit = { done: false, frames: [] };
    const start = performance.now();
    let first = 0;
    const sample = () => {
      const canvas = document.querySelector<HTMLCanvasElement>("#assistant-pane canvas");
      if (canvas && getComputedStyle(canvas).visibility === "visible" && canvas.getBoundingClientRect().width > 0) {
        first ||= performance.now();
        const box = canvas.getBoundingClientRect();
        const mount = canvas.parentElement!.getBoundingClientRect();
        state.paneFit.frames.push({ t: performance.now() - start, mount: mount.width, canvas: box.width, right: box.right, mountRight: mount.right, height: mount.height });
      }
      if ((first && performance.now() - first >= 2_500) || performance.now() - start > 10_000) state.paneFit.done = true;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  let sockets = 0;
  const geometry: { type: string; cols: number; rows: number }[] = [];
  page.on("websocket", ws => {
    if (!ws.url().includes("/ws/pty")) return;
    sockets++;
    ws.on("framesent", frame => {
      if (typeof frame.payload !== "string") return;
      const message = JSON.parse(frame.payload);
      if (["attach", "resize", "layout_stable"].includes(message.type)) geometry.push(message);
    });
  });
  await page.goto(server.baseUrl);
  if (entry === "dashboard") {
    await expect(page.locator("#dashboard-focus .focus-next li").first()).toBeVisible();
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  }
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { paneFit: { done: boolean } }).paneFit.done), { timeout: 12_000 }).toBe(true);
  const evidence = await page.evaluate(() => ({ fit: (window as unknown as { paneFit: unknown }).paneFit, trace: window.__wf_dumpTrace?.("assistant") }));
  writeFileSync(info.outputPath("first-fit.json"), JSON.stringify({ ...evidence, sockets, geometry }, null, 2));
  const frames = (evidence.fit as { frames: { mount: number; canvas: number; right: number; mountRight: number }[] }).frames;
  expect(frames.length).toBeGreaterThan(0);
  expect.soft(frames.filter(f => f.canvas > f.mount + 1 || f.right > f.mountRight + 1), "every visible frame fits from the first reveal").toEqual([]);
  expect.soft(sockets, "no reconnect is needed to repair the first fit").toBe(1);
  expect.soft(geometry.filter(g => g.type === "attach")).toHaveLength(1);
  expect.soft(new Set(geometry.map(g => `${g.cols}x${g.rows}`)).size, "attach and resize/stability frames share the pane's settled geometry").toBe(1);
  await page.screenshot({ path: info.outputPath(`first-fit-${entry.replaceAll(" ", "-")}.png`), fullPage: true });
});
