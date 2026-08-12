import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_CAPABILITY } from "../../src/tailnet-machine-contract.ts";
import type { Subprocess } from "bun";

const root = process.cwd();
const cliEntry = join(root, "src/cli/index.ts");
const ORIGIN = "https://peer.example.ts.net";
const JWT_SECRET = "remote-cli-test-secret-that-is-at-least-32-bytes";
const tempHomes: string[] = [];

function handshake(origin = ORIGIN): object {
  return {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: {
      tailnetNodeId: "n-peer",
      installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
      displayName: "peer",
      origin,
    },
    wolfpack: { version: "1.7.0" },
    capabilities: [MACHINE_CAPABILITY.SESSIONS],
  };
}

function spawnCli(args: readonly string[], fixtureUrl: string): Subprocess<"ignore", "pipe", "pipe"> {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-remote-cli-"));
  tempHomes.push(home);
  mkdirSync(join(home, ".wolfpack"), { recursive: true });
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({
    devDir: root,
    port: 18790,
    tailscaleHostname: "local.example.ts.net",
  }));
  const preload = join(home, "remote-fetch-preload.ts");
  writeFileSync(preload, `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== ${JSON.stringify(ORIGIN)}) {
        throw new Error("unexpected non-remote request: " + String(input));
      }
      return nativeFetch(${JSON.stringify(fixtureUrl)} + url.pathname + url.search, init);
    };
  `);
  return Bun.spawn([process.execPath, "--preload", preload, cliEntry, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      WOLFPACK_JWT_SECRET: JWT_SECRET,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("remote machine cli network boundary", () => {
  test("authenticates the handshake and mutation, preserves sessionId, and emits canonical machine identity", async () => {
    const requests: Array<{ readonly path: string; readonly authorization: string | null }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
        if (url.pathname === "/api/machine") return Response.json(handshake());
        if (url.pathname === "/api/session-create") {
          return Response.json({
            ok: true,
            session: "project",
            sessionId: "server-owned-session-id",
            project: "project",
            harness: "pi",
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    try {
      const child = spawnCli([
        "--machine", "peer", "session", "create", "project", "--harness", "pi", "--json",
      ], `http://127.0.0.1:${server.port}`);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(requests.map(({ path }) => path)).toEqual(["/api/machine", "/api/session-create"]);
      expect(requests.every(({ authorization }) => authorization?.startsWith("Bearer ") === true)).toBe(true);
      const output = JSON.parse(stdout);
      expect(output.sessionId).toBe("server-owned-session-id");
      expect(output.machine).toEqual((handshake() as { readonly machine: object }).machine);
    } finally {
      server.stop(true);
    }
  });

  for (const command of ["list", "ls"] as const) {
    test(`routes the ${command} alias through handshake verification`, async () => {
      const paths: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/api/machine") return Response.json(handshake());
          if (path === "/api/session-control/list") return Response.json({ sessions: [] });
          return new Response("unexpected", { status: 500 });
        },
      });

      try {
        const child = spawnCli(["--machine", "peer", command, "--json"], `http://127.0.0.1:${server.port}`);
        const [exitCode, stdout] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
        ]);

        expect(exitCode).toBe(0);
        expect(paths).toEqual(["/api/machine", "/api/session-control/list"]);
        expect(JSON.parse(stdout).machine).toEqual((handshake() as { readonly machine: object }).machine);
      } finally {
        server.stop(true);
      }
    });
  }

  test("origin mismatch fails before mutation without localhost fallback", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === "/api/machine") {
          return Response.json(handshake("https://other.example.ts.net"));
        }
        return Response.json({ ok: true });
      },
    });

    try {
      const child = spawnCli([
        "--machine", "peer", "kill", "server-owned-session-id", "--json",
      ], `http://127.0.0.1:${server.port}`);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(paths).toEqual(["/api/machine"]);
      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        error: {
          code: "INCOMPATIBLE_MACHINE",
          message: "machine handshake is incompatible with session control",
        },
      });
    } finally {
      server.stop(true);
    }
  });
});
