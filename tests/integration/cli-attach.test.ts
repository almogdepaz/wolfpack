import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { directAttach } from "../../src/cli/attach.ts";

process.env.WOLFPACK_TEST = "1";

const { __resetBackend, __setTestBackend } = await import("../../src/server/backend.ts");
const { createServerInstance } = await import("../../src/server/index.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { teardownPty } = await import("../../src/server/websocket.ts");

class TestStdin extends EventEmitter {
  isTTY = true;
  writeInput(data: Buffer | string): void {
    this.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
}

class TestStdout extends EventEmitter {
  isTTY = true;
  columns = 90;
  rows = 31;
  chunks: Buffer[] = [];
  write(data: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

class TestStderr extends EventEmitter {
  chunks: string[] = [];
  write(data: string | Buffer): boolean {
    this.chunks.push(String(data));
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

class AttachMockBackend extends MockBackend {
  writeCalls: Buffer[] = [];
  prefill = Buffer.from("prefill bytes\n");

  writeToTerminal(_name: string, data: Buffer | string): void {
    this.writeCalls.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  async getSessionPrefill(): Promise<{ data: Buffer; seq?: bigint }> {
    return { data: this.prefill };
  }
}

let server: Server;
let baseWsUrl: string;
let backend: AttachMockBackend;

beforeEach(async () => {
  backend = new AttachMockBackend({ sessions: ["attach-one"] });
  __setTestBackend(backend);
  ({ server } = createServerInstance());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      baseWsUrl = `ws://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach(() => {
  teardownPty("attach-one");
  server.close();
  __resetBackend();
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("cli direct attach over /ws/pty", () => {
  test("handshakes, receives prefill, forwards input, resizes, and detaches cleanly", async () => {
    const stdin = new TestStdin();
    const stdout = new TestStdout();
    const stderr = new TestStderr();
    const attach = directAttach({
      session: "attach-one",
      takeControl: false,
      prefillMode: "full",
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: stderr as any,
      websocketUrl: `${baseWsUrl}/ws/pty?session=attach-one`,
      rawMode: false,
    });

    await wait(350);
    expect(stdout.text()).toContain("prefill bytes");
    expect(backend.lastResizeArgs).toEqual({ name: "attach-one", cols: 90, rows: 31 });

    stdin.writeInput("abc");
    await wait(20);
    expect(Buffer.concat(backend.writeCalls).toString("utf-8")).toContain("abc");

    stdout.columns = 100;
    stdout.rows = 35;
    stdout.emit("resize");
    await wait(120);
    expect(backend.lastResizeArgs).toEqual({ name: "attach-one", cols: 100, rows: 35 });

    stdin.writeInput(Buffer.from([0x1d]));
    expect(await attach).toBe(0);
    expect(stderr.text()).toBe("");
  });

  test("viewer conflict exits unless takeover is explicit", async () => {
    const holder = new WebSocket(`${baseWsUrl}/ws/pty?session=attach-one`);
    await new Promise<void>((resolve, reject) => {
      holder.addEventListener("open", () => {
        holder.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
        resolve();
      });
      holder.addEventListener("error", () => reject(new Error("holder connect failed")));
    });

    const stdin = new TestStdin();
    const stdout = new TestStdout();
    const stderr = new TestStderr();
    const code = await directAttach({
      session: "attach-one",
      takeControl: false,
      prefillMode: "none",
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: stderr as any,
      websocketUrl: `${baseWsUrl}/ws/pty?session=attach-one`,
      rawMode: false,
    });

    expect(code).toBe(2);
    expect(stderr.text()).toContain("Viewer conflict");
    holder.close();
  });
});
