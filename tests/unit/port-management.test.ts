import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { isPortInUse, killPortHolder } from "../../src/cli/index.ts";

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("isPortInUse", () => {
  test("returns false for unused port", () => {
    // Port 0 is never "in use" in the lsof/ss sense
    expect(isPortInUse(0)).toBe(false);
  });

  test("returns false for invalid port", () => {
    expect(isPortInUse(-1)).toBe(false);
    expect(isPortInUse(99999)).toBe(false);
    expect(isPortInUse(NaN)).toBe(false);
  });

  test("detects a port that is actually in use", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as AddressInfo).port);
      });
    });

    try {
      expect(isPortInUse(port)).toBe(true);
    } finally {
      await closeServer(srv);
    }
  });

  test("returns false after server closes", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as AddressInfo).port);
      });
    });
    await closeServer(srv);
    expect(isPortInUse(port)).toBe(false);
  });

  test("does not mistake a UDP socket for an HTTP listener", async () => {
    const srv = createServer();
    const socket = createSocket("udp4");
    try {
      // Reserve the TCP namespace too: UDP port 0 alone could select a port
      // legitimately occupied by an unrelated TCP listener.
      const tcpListening = once(srv, "listening");
      srv.listen(0, "127.0.0.1");
      await tcpListening;
      const port = (srv.address() as AddressInfo).port;
      const udpListening = once(socket, "listening");
      socket.bind(port, "127.0.0.1");
      await udpListening;
      await closeServer(srv);
      expect(isPortInUse(port)).toBe(false);
    } finally {
      try {
        await new Promise<void>(resolve => socket.close(resolve));
      } finally {
        if (srv.listening) await closeServer(srv);
      }
    }
  });

  test("does not mistake an established client endpoint for a listener", async () => {
    const srv = createServer();
    const listening = once(srv, "listening");
    srv.listen(0, "127.0.0.1");
    await listening;
    const port = (srv.address() as AddressInfo).port;
    const accepted = once(srv, "connection");
    const client = createConnection({ host: "127.0.0.1", port });
    let peer: Socket | undefined;
    try {
      await once(client, "connect");
      [peer] = await accepted;
      expect(isPortInUse(port)).toBe(true);
      expect(isPortInUse(client.localPort!)).toBe(false);
    } finally {
      client.destroy();
      peer?.destroy();
      await closeServer(srv);
    }
  });
});

describe("killPortHolder", () => {
  test.each(["udp", "client", "listener"] as const)("uses TCP-listener ownership for a %s endpoint (all signals intercepted)", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-port-selector-"));
    // The child's real argv contains "wolfpack", so the existing process-identity
    // guard cannot hide a selector regression. Never send any actual signal.
    const script = join(root, "wolfpack-port-owner.ts");
    try {
      writeFileSync(script, `
import { createServer, createConnection } from "node:net";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { killPortHolder } from ${JSON.stringify(join(import.meta.dirname, "../../src/cli/config.ts"))};
const kind = ${JSON.stringify(kind)};
const server = createServer();
const udp = createSocket("udp4");
let client, peer, udpBound = false;
try {
  let port;
  if (kind === "udp") {
    const tcpListening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await tcpListening;
    port = server.address().port;
    const udpListening = once(udp, "listening");
    udp.bind(port, "127.0.0.1");
    await udpListening;
    udpBound = true;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } else {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    port = server.address().port;
    if (kind === "client") {
      const accepted = once(server, "connection");
      client = createConnection({ host: "127.0.0.1", port });
      await once(client, "connect");
      [peer] = await accepted;
      port = client.localPort;
    }
  }
  const calls = [];
  const originalKill = process.kill;
  let result;
  process.kill = (pid, signal) => { calls.push([pid, signal]); return true; };
  try { result = killPortHolder(port); }
  finally { process.kill = originalKill; }
  console.log(JSON.stringify({ pid: process.pid, result, calls }));
} finally {
  client?.destroy();
  peer?.destroy();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (udpBound) await new Promise(resolve => udp.close(resolve));
}
`);
      const child = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const result = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
      expect(result.result).toBe(kind === "listener");
      expect(result.calls).toEqual(kind === "listener" ? [[result.pid, "SIGTERM"]] : []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns false for unused port (nothing to kill)", () => {
    expect(killPortHolder(0)).toBe(false);
  });

  test("returns false for invalid port", () => {
    expect(killPortHolder(-1)).toBe(false);
    expect(killPortHolder(NaN)).toBe(false);
  });

  test("does not kill a process after its listener closes", async () => {
    // Own the listener in this process; never signal a live test runner.
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as AddressInfo).port);
      });
    });

    try {
      expect(isPortInUse(port)).toBe(true);
    } finally {
      await closeServer(srv);
    }

    // After closing, killPortHolder should find nothing to kill
    expect(killPortHolder(port)).toBe(false);
  });
});
