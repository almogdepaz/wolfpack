import type { Page } from "@playwright/test";
// Agent-context v3 fixture shaped by .plans/focus-cards-ref/context.schema.json.
export const SESSION_UUID = "3f1c2a9e-7b4d-4e21-9c0a-5d6e7f8a9b0c";
const item = (id: string, text: string) => ({ id, text });
export const v3 = {
  schemaVersion: 3,
  goal: "Ship the focus cards round",
  now: { id: "cards", text: "Wire the context block into session cards", details: "So the dashboard answers what each agent is doing." },
  needsYou: [item("approve-copy", "Approve the <img src=x onerror=alert(1)> state copy"), ...["a", "b", "c", "d", "e", "f"].map(k => item(`q-${k}`, `question ${k}`))],
  needToKnow: [item("bundle", "Bundle cap is a loose guard"), item("local", "Changes are local"), item("pi", "pi 1.3.0 here"), item("hidden", "fourth fact stays out")],
  nextSteps: [{ id: "test", text: "Run the e2e", owner: "agent" }, { id: "look", text: "Look at the captures", owner: "user" }],
  history: [{ id: "h1", text: "Cards over a drawer", kind: "decision" }],
  source: { harness: "pi", sessionId: "pi-session", branchId: null, coveredEntryId: null },
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  freshness: "reviewed",
  activity: { state: "working", observedAt: new Date().toISOString() },
};
/** `document` may be a getter so a test can change what the next read returns. */
export async function withContext(page: Page, document: unknown, patchSession?: (session: Record<string, unknown>) => void) {
  const current = () => typeof document === "function" ? document() : document;
  const reads: string[] = [];
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    // a canonical uuid (the document route requires one) and a project path (the mock backend reports none)
    const session = body.sessions.find((s: { name: string }) => s.name === "prompt-project");
    session.identity = { ...session.identity, wolfpackSessionId: SESSION_UUID, projectPath: "/home/dev/demo-app" };
    patchSession?.(session);
    await route.fulfill({ response, json: body });
  });
  // a valid catalog (the app's extension host parses it too); no `ui`, so nothing tries to load an asset
  const installation = (extensionId: string, documents: { id: string; schemaVersion: number }[]) => ({ installationId: "6d2f8c1e-4a3b-4c5d-8e9f-0a1b2c3d4e5f", extensionId, enabled: true, package: { name: `wolfpack-extension-${extensionId}`, version: "0.1.0", digest: "a".repeat(64) }, blobs: null, documents });
  await page.route(url => url.pathname === "/api/extensions", route => route.fulfill({ json: { safeMode: false, installations: [installation("changes", []), installation("agent-context", [{ id: "context", schemaVersion: 3 }])] } }));
  await page.route(url => url.pathname === "/api/extensions/documents/agent-context/context", route => {
    reads.push(new URL(route.request().url()).searchParams.get("session") ?? "");
    return route.fulfill({ json: { installationId: "i", scopeSessionId: SESSION_UUID, extensionId: "agent-context", documentId: "context", revision: current() ? 3 : 0, document: current() } });
  });
  return reads;
}
