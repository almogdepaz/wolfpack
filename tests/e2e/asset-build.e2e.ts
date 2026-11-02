import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openSessionFromUi, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

for (const mode of ["normal", "reduced-motion", "forced-colors"] as const) test(`canonical stylesheet preserves cascade, animations and accessibility (${mode})`, async ({ page, context }, testInfo) => {
  const reference = readFileSync(process.env.WOLFPACK_STYLES_REFERENCE ?? new URL("../../src/browser/styles.css", import.meta.url), "utf8");
  const shipped = readFileSync(new URL("../../public/styles.css", import.meta.url), "utf8");
  const media = { reducedMotion: mode === "reduced-motion" ? "reduce" as const : "no-preference" as const, forcedColors: mode === "forced-colors" ? "active" as const : "none" as const };
  await page.emulateMedia(media);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/styles.css");
  await page.goto(server.baseUrl);
  const received = await (await response).body();
  expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(shipped).digest("hex"));
  await expect(page.locator(".card").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const compare = async (surface: string) => {
    // Freeze the real surface as an inert DOM/canvas snapshot. This prevents
    // refresh/reconnect clocks from changing between the two CSS screenshots.
    const snapshot = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('script, link[rel="stylesheet"]').forEach(node => node.remove());
      const original = [...document.querySelectorAll("body, body *")];
      return { html: `<!doctype html>${clone.outerHTML}`, focus: original.indexOf(document.activeElement!),
        scroll: { x: scrollX, y: scrollY },
        canvases: [...document.querySelectorAll("canvas")].map(canvas => canvas.toDataURL()),
        inputs: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")].map(input => ({ value: input.value, checked: input instanceof HTMLInputElement ? input.checked : false })),
      };
    });
    const probe = await context.newPage();
    await probe.emulateMedia(media);
    try {
      await probe.route("**/__asset_css_snapshot__", route => route.fulfill({ contentType: "text/html", body: snapshot.html }));
      await probe.goto(`${server.baseUrl}/__asset_css_snapshot__`);
      await probe.evaluate(async snapshot => {
        const inputs = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")];
        snapshot.inputs.forEach((state, index) => { const input = inputs[index]!; input.value = state.value; if (input instanceof HTMLInputElement) input.checked = state.checked; });
        await Promise.all([...document.querySelectorAll("canvas")].map(async (canvas, index) => {
          const image = new Image(); image.src = snapshot.canvases[index]!; await image.decode(); canvas.getContext("2d")!.drawImage(image, 0, 0);
        }));
        const style = document.createElement("style"); style.id = "asset-css-probe"; document.head.append(style);
        const focus = document.querySelectorAll<HTMLElement>("body, body *")[snapshot.focus];
        focus?.focus({ preventScroll: true });
        scrollTo(snapshot.scroll.x, snapshot.scroll.y);
      }, snapshot);
      const capture = async (css: string) => {
        const metrics = await probe.evaluate(async css => {
          document.getElementById("asset-css-probe")!.textContent = css;
          await document.fonts.ready;
          void document.body.offsetHeight;
          for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 1000; }
          void document.body.offsetHeight;
          // CSSOM does not canonicalize all equivalent spellings (0%/0px,
          // gradient angles/custom-token whitespace). Compare resolved layout,
          // interaction/motion properties plus exact rendered pixels instead.
          const properties = ["display", "visibility", "position", "z-index", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "font-family", "font-size", "font-weight", "line-height", "text-align", "white-space", "overflow-x", "overflow-y", "opacity", "transform", "pointer-events", "touch-action", "user-select", "outline-width", "outline-style", "outline-offset", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "animation-name", "animation-duration", "animation-timing-function", "animation-iteration-count", "animation-delay", "animation-direction", "animation-fill-mode", "animation-play-state", "transition-delay", "transition-duration", "transition-property", "transition-timing-function"];
          const rows = [...document.querySelectorAll("body, body *")].flatMap(element => [null, "::before", "::after"].map(pseudo => {
            const style = getComputedStyle(element, pseudo);
            return properties.map(property => style.getPropertyValue(property));
          }));
          return { properties, rows, timing: document.getAnimations().map(animation => animation.effect?.getTiming()),
            media: { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, forcedColors: matchMedia("(forced-colors: active)").matches } };
        }, css);
        const pixels = await probe.screenshot({ fullPage: true, caret: "hide" });
        return { metrics, pixels };
      };
      const before = await capture(reference), after = await capture(shipped);
      const differences: Array<{ row: number; property: string; before: string; after: string }> = [];
      after.metrics.rows.forEach((row, index) => row.forEach((value, column) => {
        const prior = before.metrics.rows[index]?.[column];
        if (value !== prior && differences.length < 30) differences.push({ row: index, property: after.metrics.properties[column]!, before: prior ?? "missing", after: value });
      }));
      const pixels = await probe.evaluate(async ({ before, after }) => {
        const decode = async (base64: string) => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode(); return image; };
        const a = await decode(before), b = await decode(after);
        if (a.width !== b.width || a.height !== b.height) return { sameSize: false, differences: -1, maxChannelDelta: -1, width: b.width, height: b.height };
        const canvas = document.createElement("canvas"); canvas.width = a.width; canvas.height = a.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(a, 0, 0); const first = ctx.getImageData(0, 0, a.width, a.height).data;
        ctx.clearRect(0, 0, a.width, a.height); ctx.drawImage(b, 0, 0); const second = ctx.getImageData(0, 0, b.width, b.height).data;
        let differences = 0, maxChannelDelta = 0;
        for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) { differences++; maxChannelDelta = Math.max(maxChannelDelta, Math.abs(first[index]! - second[index]!)); }
        return { sameSize: true, differences, maxChannelDelta, width: a.width, height: a.height };
      }, { before: before.pixels.toString("base64"), after: after.pixels.toString("base64") });
      const result = { surface, mode, actualMedia: after.metrics.media, rows: after.metrics.rows.length, differences, timingDeclarationsCompared: true, pixels };
      console.log(`css-equivalence-json:${JSON.stringify({ ...result, beforeTiming: before.metrics.timing, afterTiming: after.metrics.timing })}`);
      await testInfo.attach(`css-equivalence-${surface}-${mode}.json`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      if (pixels.differences !== 0 || differences.length > 0) {
        await testInfo.attach(`css-reference-${surface}.png`, { body: before.pixels, contentType: "image/png" });
        await testInfo.attach(`css-shipped-${surface}.png`, { body: after.pixels, contentType: "image/png" });
      }
      expect(differences, `${surface} resolved layout/interaction`).toEqual([]);
      expect(pixels, `${surface} rendered pixels`).toMatchObject({ sameSize: true, differences: 0 });
    } finally { await probe.close(); await page.bringToFront(); }
  };
  await compare("dashboard");
  await openSessionFromUi(page, "test-project");
  await compare("terminal");
  await page.evaluate(() => document.getElementById(window.innerWidth > 768 ? "sidebar-settings-btn" : "gear-btn")?.click());
  await expect(page.locator("#settings-view")).toBeVisible();
  await compare("settings");
});
