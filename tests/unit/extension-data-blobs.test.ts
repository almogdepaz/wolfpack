import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as api from "../../src/cli/api.ts";
import { extensionDataCommand, extensionDataUsage } from "../../src/cli/extension-data.ts";
const session = "11111111-1111-4111-8111-111111111111";
import * as formatting from "../../src/cli/formatting.ts";
test("blob CLI follows symlinked build outputs with a bounded target read", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-blob-links-")), file = join(root, "build.bin"), link = join(root, "latest.bin"); writeFileSync(file, Buffer.from([9])); symlinkSync(file, link);
  let uploaded = false; const output: unknown[] = [];
  const print = spyOn(formatting, "printApiJson").mockImplementation(value => { output.push(value); });
  const stub = spyOn(api, "call").mockImplementation(async (path, options) => {
    if (path === "/api/extensions") return Response.json({ installations: [{ extensionId: "stage", enabled: true, blobs: { maxBlobBytes: 64 } }] });
    if (options?.method === "PUT") { uploaded = true; expect(options.body).toEqual(Buffer.from([9])); return Response.json({ digest: "a".repeat(64), bytes: 1, created: true }); }
    return new Response("proxy failure", { status: 503 });
  });
  try {
    expect(await extensionDataCommand(["put-blob", "stage", "--session", session, "--file", link, "--json"])).toBe(0); expect(uploaded).toBe(true); expect(output).toEqual([{ digest: "a".repeat(64), bytes: 1, created: true }]);
  } finally { stub.mockRestore(); print.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
test("blob CLI emits ok:false for non-JSON errors", async () => {
  const output: unknown[] = [];
  const print = spyOn(formatting, "printApiJson").mockImplementation(value => { output.push(value); });
  const stub = spyOn(api, "call").mockResolvedValue(new Response("proxy failure", { status: 503 }));
  try { expect(await extensionDataCommand(["delete-blob", "stage", "--session", session, "--digest", "a".repeat(64), "--json"])).toBe(1); expect(output).toEqual([{ ok: false, error: { code: "INVALID_RESPONSE", message: "server returned invalid JSON" } }]); } finally { stub.mockRestore(); print.mockRestore(); }
});
test("blob CLI validates args and uploads hashed bytes through selected machine", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-blobs-")), file = join(root, "fixture.bin"); writeFileSync(file, Buffer.from([0, 255]));
  const digest = require("node:crypto").createHash("sha256").update(Buffer.from([0, 255])).digest("hex");
  const target = { origin: "https://example.test", machineId: "machine" } as never; let max = 64, uploads = 0;
  const stub = spyOn(api, "call").mockImplementation(async (path, options, machine) => {
    expect(machine).toBe(target);
    if (path === "/api/extensions") return Response.json({ installations: [{ extensionId: "stage", enabled: true, blobs: { maxBlobBytes: max } }] });
    expect(path).toBe(`/api/extensions/blobs/stage/${digest}?session=${session}`);
    if (options?.method === "PUT") { uploads++; expect(options.headers).toEqual({ "Content-Type": "application/octet-stream" }); expect(options.body).toEqual(Buffer.from([0, 255])); return Response.json({ digest, bytes: 2, created: true, installationId: session, extensionId: "stage" }); }
    expect(options?.method).toBe("DELETE"); return Response.json({ digest, deleted: true });
  });
  try {
    expect(extensionDataUsage()).toContain("put-blob");
    for (const argv of [["put-blob", "stage", "--session", "name", "--file", file], ["delete-blob", "stage", "--session", session, "--digest", "no"], ["put-blob", "../stage", "--session", session, "--file", file], ["put-blob", "stage", "--session", session, "--file", file, "--extra", "x"]]) expect(await extensionDataCommand(argv, target)).toBe(2);
    expect(await extensionDataCommand(["put-blob", "stage", "--session", session, "--file", file, "--json"], target)).toBe(0);
    expect(await extensionDataCommand(["delete-blob", "stage", "--session", session, "--digest", digest, "--json"], target)).toBe(0);
    max = 1; expect(await extensionDataCommand(["put-blob", "stage", "--session", session, "--file", file], target)).toBe(1); expect(uploads).toBe(1);
  } finally { stub.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
