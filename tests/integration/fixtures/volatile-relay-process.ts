// Test-only loopback HTTP harness, not production routing/auth middleware.
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { WorkerRelayGateway } from "../../../src/task-relay/worker-client.ts";
import { VOLATILE_RELAY_PATH, VOLATILE_PEER_PATH } from "../../../src/task-relay/volatile-protocol.ts";
const [root, origin] = process.argv.slice(2) as [string, string];
if (!isAbsolute(root ?? "") || !origin || process.env.WOLFPACK_TEST !== "1" || process.env.HOME !== root) {
  throw new Error("volatile fixture requires an explicit root, private HOME and test mode");
}
const peers = new Map<string, string>();
let loseReply = process.env.LOSE_ACCEPTED_REPLY === "1";
const gateway = new WorkerRelayGateway({ root, profile: "volatile-v1", peerOrigin: origin,
  inspectSession: async selector => ({ ok: true, session: selector, sessionId: selector, projectPath: root, harness: "pi", alive: true }),
  peerFetch: async (input, init) => {
    const url = new URL(String(input)), destination = peers.get(url.origin);
    if (!destination) throw new Error("fixture peer not configured");
    return fetch(`${destination}${url.pathname}`, init);
  },
});
await gateway.initialize();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 64 * 1024, async fetch(request) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const path = new URL(request.url).pathname, input = await request.json();
  if (path === "/fixture/peer") {
    const { canonical, loopback } = input as { canonical: string; loopback: string };
    const url = new URL(loopback);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.origin !== loopback || url.username || url.password) throw new Error("fixture requires loopback peer");
    peers.set(canonical, loopback); return Response.json({ ok: true });
  }
  if (path === "/fixture/topology") return Response.json(await gateway.volatileTopology(input));
  if (path === "/fixture/legacy") return Response.json(await gateway.connect(input as Parameters<typeof gateway.connect>[0]));
  if (path !== VOLATILE_RELAY_PATH && path !== VOLATILE_PEER_PATH) return new Response(null, { status: 404 });
  const result = path === VOLATILE_PEER_PATH ? await gateway.volatilePeer(input) : await gateway.volatile(input);
  if (path === VOLATILE_PEER_PATH && result.ok && result.value.kind === "accepted" && loseReply) {
    loseReply = false;
    // Actual receiver worker committed the mailbox; withhold its confirmation.
    return Response.json({ fixture: "accepted reply lost" }, { status: 503 });
  }
  return Response.json(result, { status: result.ok ? 200 : 409 });
} });
process.on("SIGTERM", () => { void (async () => { await server.stop(true); await gateway.close(); process.exit(0); })(); });
writeFileSync(join(root, "ready.json"), JSON.stringify({ port: server.port }), { mode: 0o600 });
