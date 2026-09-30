import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";

/** Layout tests need a real SDK contribution, not the now-removed empty diagnostic panel.
 * Only catalog/asset transport is mocked; production verification/loading/mounting is used.
 */
export async function mockLayoutWidget(page: Page, sessionIds: Readonly<Record<string, string>> = {}): Promise<void> {
  if (Object.keys(sessionIds).length) await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    for (const session of body.sessions) if (sessionIds[session.name]) session.identity.wolfpackSessionId = sessionIds[session.name];
    await route.fulfill({ response, json: body });
  });
  const code = `export default host => host.registerContextView({ id: "view", title: "Widgets", mount(container) { container.textContent = "Widget fixture"; return { dispose() {}, setVisible(visible) { container.hidden = !visible; } }; } });`;
  const digest = createHash("sha256").update(code).digest("hex");
  const url = `/api/extensions/assets/test-widgets/${digest}/ui.js`;
  await page.route("**/api/extensions", route => route.fulfill({ json: { safeMode: false, installations: [{
    installationId: "33333333-3333-4333-8333-333333333333", extensionId: "test-widgets", enabled: true,
    package: { name: "test-widgets", version: "1.0.0", digest }, documents: [],
    ui: { path: "ui.js", url, digest, mime: "text/javascript" },
  }] } }));
  await page.route(`**${url}`, route => route.fulfill({ contentType: "text/javascript", body: code }));
}
