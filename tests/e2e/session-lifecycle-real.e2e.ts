import { expect, test } from "@playwright/test";
import { startTestServer } from "./helpers.ts";

for (const lifecycleEvents of [false, true]) {
  test(`real server exit ${lifecycleEvents ? "invalidates before polling" : "without an event waits for polling"}`, async ({ page }) => {
    const server = await startTestServer({ lifecycleEvents });
    try {
      let summaries = 0;
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/sessions") summaries++; });
      const streamResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/events");
      await page.clock.install();
      await page.goto(server.baseUrl);
      const stream = await streamResponse;
      expect(stream.status()).toBe(200);
      expect(stream.headers()["content-type"]).toBe("text/event-stream");
      expect(new URL(stream.url()).searchParams.get("kinds")).toBe("session.created,session.exited");
      const exited = page.getByRole("button", { name: "Open another-project", exact: true });
      await expect(exited).toBeVisible();
      // Settle initial subscribe-before-snapshot repair, then freeze all page
      // timers. HTTP and the real streaming response continue independently.
      await page.clock.pauseAt(new Date(Date.now() + 500));
      await expect.poll(() => summaries).toBeGreaterThanOrEqual(2);
      const before = summaries;
      const killed = await page.request.post(`${server.baseUrl}/api/kill`, { data: { session: "another-project" } });
      expect(killed.status()).toBe(200);
      expect((await killed.json()).sessionId).toBe("mock:another-project");
      // The real server fixture emits after the mock exit, not from a UI stop
      // handler. No page.route or in-browser EventSource/stream substitute.
      await page.clock.runFor(250);
      if (lifecycleEvents) {
        await expect(exited).toHaveCount(0, { timeout: 2_000 });
        expect(summaries).toBe(before + 1);
      } else {
        await expect(exited).toBeVisible();
        expect(summaries).toBe(before);
        await page.clock.runFor(5_000);
        await expect(exited).toHaveCount(0);
      }
      await expect(page.getByRole("button", { name: "Open test-project", exact: true })).toBeVisible();
    } finally { await server.close(); }
  });
}
