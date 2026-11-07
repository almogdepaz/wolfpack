import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityPeerTransportUrl } from "../../src/server/activity-peers.ts";

const origin = (name: string) => `https://${name}.tail123.ts.net`;
const node = (name: string) => ({ ID: `node-${name}`, DNSName: `${name}.tail123.ts.net.`, HostName: name, Online: true, UserID: 1 });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function privateHome(root: string, name: string): string {
  const home = join(root, name);
  mkdirSync(join(home, ".wolfpack"), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ devDir: home, port: 18790, tailscaleHostname: `${name}.tail123.ts.net` }), { mode: 0o600 });
  return home;
}

test("the transport seam applies only under WOLFPACK_TEST and only to mapped origins", () => {
  const map = JSON.stringify({ [origin("peer")]: "http://127.0.0.1:1234" });
  expect(activityPeerTransportUrl(origin("peer"), { WOLFPACK_TEST: "1", WOLFPACK_FOCUS_PEER_URLS_JSON: map })).toBe("http://127.0.0.1:1234");
  expect(activityPeerTransportUrl(origin("peer"), { WOLFPACK_FOCUS_PEER_URLS_JSON: map })).toBe(origin("peer"));
  expect(activityPeerTransportUrl(origin("other"), { WOLFPACK_TEST: "1", WOLFPACK_FOCUS_PEER_URLS_JSON: map })).toBe(origin("other"));
  expect(activityPeerTransportUrl(origin("peer"), { WOLFPACK_TEST: "1", WOLFPACK_FOCUS_PEER_URLS_JSON: "{bad" })).toBe(origin("peer"));
});

test("peer journal reads over the owner bearer: redirects, oversized bodies and journal-less peers are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "activity-peers-"));
  const secret = randomBytes(32).toString("hex");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const stubs: ReturnType<typeof Bun.serve>[] = [];
  try {
    // a real peer server in its own process: own home, own tailnet identity, owner auth required
    const peerHome = privateHome(root, "peer");
    const nonce = randomUUID();
    const peerStatus = { BackendState: "Running", Self: node("peer"), Peer: { home: node("home") } };
    children.push(Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/activity-peer-server.ts"), peerHome, nonce], {
      cwd: peerHome, env: { PATH: process.env.PATH, HOME: peerHome, WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: secret, WOLFPACK_BROKER_SOCKET: join(peerHome, "no-broker.sock"),
        WOLFPACK_TAILSCALE_STATUS_JSON: JSON.stringify(peerStatus) }, stdin: "ignore", stdout: Bun.file(join(peerHome, "stdout.log")), stderr: Bun.file(join(peerHome, "stderr.log")),
    }));
    const deadline = Date.now() + 8000;
    while (!existsSync(join(peerHome, "ready.json")) && children[0]!.exitCode === null && Date.now() < deadline) await pause(10);
    if (!existsSync(join(peerHome, "ready.json"))) throw new Error(`peer fixture failed: ${readFileSync(join(peerHome, "stderr.log"), "utf8").slice(-2000)}`);
    const ready = JSON.parse(readFileSync(join(peerHome, "ready.json"), "utf8"));
    expect(ready.nonce).toBe(nonce);
    const peerBase = `http://127.0.0.1:${ready.port}`;
    expect((await fetch(`${peerBase}/api/activity`)).status).toBe(401);
    const machine = await (await fetch(`${peerBase}/api/machine`)).json();
    expect(machine.machine.origin).toBe(origin("peer"));

    // misbehaving peers that still pass the machine handshake (or fail it by redirecting)
    const handshake = (name: string) => ({ ...machine, machine: { ...machine.machine, origin: origin(name), tailnetNodeId: `node-${name}`, installationId: randomUUID(), displayName: name } });
    const stub = (handler: (path: string) => Response) => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(new URL(request.url).pathname) });
      stubs.push(server);
      return `http://127.0.0.1:${server.port}`;
    };
    const urls = {
      [origin("peer")]: peerBase,
      [origin("moved")]: stub(() => new Response(null, { status: 302, headers: { location: `${peerBase}/api/machine` } })),
      [origin("huge")]: stub(path => path === "/api/machine" ? Response.json(handshake("huge")) : new Response("x".repeat(200_000))),
      [origin("bare")]: stub(path => path === "/api/machine" ? Response.json(handshake("bare")) : Response.json({ error: "not found" }, { status: 404 })),
    };

    const homeHome = privateHome(root, "home");
    const homeStatus = { BackendState: "Running", Self: node("home"), Peer: Object.fromEntries(["peer", "moved", "huge", "bare"].map(n => [n, node(n)])) };
    const home = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/activity-peers-home.ts"), homeHome, String(64 * 1024)], {
      cwd: homeHome, env: { PATH: process.env.PATH, HOME: homeHome, WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: secret,
        WOLFPACK_TAILSCALE_STATUS_JSON: JSON.stringify(homeStatus), WOLFPACK_FOCUS_PEER_URLS_JSON: JSON.stringify(urls) }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    children.push(home);
    const [out, err, code] = await Promise.all([new Response(home.stdout).text(), new Response(home.stderr).text(), home.exited]);
    expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
    const result = JSON.parse(out.trim().split("\n").at(-1)!) as { reads: { origin: string; page?: { rows: { taskId: string }[] }; error?: string }[]; failures: { origin: string; error: string }[] };
    const read = (name: string) => result.reads.find(r => r.origin === origin(name));
    expect(read("peer")?.page?.rows.map(r => r.taskId)).toEqual(["a", "b", "c"]);
    expect(read("huge")?.error).toBe("peer response unavailable or oversized");
    expect(read("bare")?.error).toStartWith("peer has no activity journal");
    expect(read("moved")).toBeUndefined();
    expect(result.failures.map(f => f.origin)).toEqual([origin("moved")]);

    // an unreadable tailnet is a single-machine setup: warned once, not every tick
    const lone = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/activity-peers-home.ts"), homeHome, "1024", "3"], {
      cwd: homeHome, env: { PATH: process.env.PATH, HOME: homeHome, WOLFPACK_TEST: "1", WOLFPACK_TAILSCALE_STATUS_JSON: JSON.stringify({ BackendState: "Stopped" }) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    children.push(lone);
    const [loneOut, loneErr, loneCode] = await Promise.all([new Response(lone.stdout).text(), new Response(lone.stderr).text(), lone.exited]);
    expect(loneCode).toBe(0);
    expect(JSON.parse(loneOut.trim().split("\n").at(-1)!)).toEqual({ reads: [], failures: [] });
    expect(loneErr).toBe("");
    expect(loneOut.split("\n").filter(line => line.includes("tailnet topology unreadable"))).toHaveLength(1);
  } finally {
    for (const server of stubs) server.stop(true);
    for (const child of children) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
