import { expect, test } from "@playwright/test";
import { startTestServer } from "./helpers";
import type { TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

test("singleton and two isolated terminals compile WASM once with separate working memories", async ({ page }) => {
  await page.addInitScript(() => {
    const counts = { compile: 0 };
    Object.assign(window, { __wasmCounts: counts });
    WebAssembly.compile = new Proxy(WebAssembly.compile, {
      apply(target, receiver, args) { counts.compile++; return Reflect.apply(target, receiver, args); },
    });
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => typeof (window as unknown as { createIsolatedGhostty?: unknown }).createIsolatedGhostty === "function");
  const result = await page.evaluate(async () => {
    type Cell = { readonly codepoint: number };
    type WasmTerminal = { write(data: Uint8Array): void; getViewport(): readonly Cell[]; free(): void };
    type Ghostty = { readonly memory: WebAssembly.Memory; createTerminal(cols: number, rows: number): WasmTerminal };
    const runtime = window as unknown as {
      readonly ghosttyReady: Promise<void>;
      readonly createIsolatedGhostty: () => Promise<Ghostty>;
      readonly __wasmCounts: { readonly compile: number };
    };
    await runtime.ghosttyReady;
    const [first, second] = await Promise.all([runtime.createIsolatedGhostty(), runtime.createIsolatedGhostty()]);
    const a = first.createTerminal(80, 24);
    const b = second.createTerminal(80, 24);
    try {
      a.write(new TextEncoder().encode("first terminal"));
      const before = b.getViewport().map((cell) => cell.codepoint);
      a.write(new TextEncoder().encode(" more output"));
      const after = b.getViewport().map((cell) => cell.codepoint);
      return { compile: runtime.__wasmCounts.compile, separateMemory: first.memory !== second.memory,
        separateBuffers: first.memory.buffer !== second.memory.buffer,
        firstHasOutput: a.getViewport().some((cell) => cell.codepoint === 102),
        otherUnchanged: JSON.stringify(before) === JSON.stringify(after) };
    } finally { a.free(); b.free(); }
  });
  expect(result).toEqual({ compile: 1, separateMemory: true, separateBuffers: true, firstHasOutput: true, otherUnchanged: true });
});
