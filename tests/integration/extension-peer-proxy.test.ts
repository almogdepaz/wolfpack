import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSelectedHostFixture, SELECTED_HOST_SESSION } from "../fixtures/selected-host-extensions.ts";
import { buildControlApiSchema } from "../../src/control-api/schema.ts";
import { isJsonObject, validateControlApiSchemaValue } from "../control-api-schema-validator.ts";

let fixture: Awaited<ReturnType<typeof createSelectedHostFixture>>;
beforeAll(async () => { fixture = await createSelectedHostFixture({ timeoutMs: 300, maxActive: 2 }); });
afterAll(async () => { if (fixture) await fixture.close(); });
function route(index: number, suffix = "catalog"): string { return `${fixture.base}/api/extensions/peer/${encodeURIComponent(fixture.peers[index]!.identity)}/${suffix}`; }
function headers(index: number): Record<string, string> { return { Authorization: `Bearer ${fixture.localToken}`, "X-Wolfpack-Extension-Peer-Authorization": `Bearer ${fixture.peers[index]!.token}`, Cookie: "local-secret=must-not-cross", "X-Private": "must-not-cross" }; }

describe("authenticated installed selected-peer extension proxy", () => {
  test("requires local owner auth and forwards only the separately selected peer credential", async () => {
    const peer = fixture.peers[0]!;
    expect((await fetch(route(0), { headers: { "X-Wolfpack-Extension-Peer-Authorization": `Bearer ${peer.token}` } })).status).toBe(401);
    expect(peer.trace).toHaveLength(0);
    const response = await fetch(route(0), { headers: headers(0) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const catalog = await response.json() as { installations: Array<{ installationId: string; package: { name: string } }> };
    expect(catalog.installations[0]?.installationId).toBe(peer.runtime.installationId);
    expect(catalog.installations[0]?.package.name).toBe("remote-only-notes-a");
    const api = peer.trace.filter(value => value.path === "/api/extensions");
    expect(api).toHaveLength(1); expect(api[0]?.authorization).toBe(`Bearer ${peer.token}`);
    expect(api[0]?.cookie).toBeUndefined(); expect(api[0]?.peerHeader).toBeUndefined();
    const handshakes = peer.trace.filter(value => value.path === "/api/machine");
    expect(handshakes).toHaveLength(2);
    expect(handshakes.every(value => value.authorization === undefined && value.cookie === undefined && value.peerHeader === undefined)).toBe(true);
    expect(peer.trace.map(value => ({ path: value.path, authorization: value.authorization }))).toEqual([
      { path: "/api/machine", authorization: undefined },
      { path: "/api/extensions", authorization: `Bearer ${peer.token}` },
      { path: "/api/machine", authorization: undefined },
    ]);
    expect(fixture.localRuntime.catalog(false).installations).toHaveLength(0);
    expect(fixture.fetchTrace.every(url => !url.includes("token"))).toBe(true);
  });
  test("source declarations validate both actual owner and selected-peer 401 envelopes on every read capability", async () => {
    const peer = fixture.peers[0]!, item = peer.runtime.catalog(false).installations[0]!;
    const schema = buildControlApiSchema();
    if (!isJsonObject(schema.http)) throw new Error("source HTTP operations unavailable");
    const capabilities = [
      ["listSelectedPeerExtensions", "catalog"],
      ["readSelectedPeerExtensionAsset", item.ui!.url.slice("/api/extensions/".length)],
      ["readSelectedPeerExtensionDocument", `documents/notes/context?session=${SELECTED_HOST_SESSION}`],
      ["readSelectedPeerExtensionProject", `project/git-status/notes?session=${SELECTED_HOST_SESSION}`],
      ["readSelectedPeerExtensionBlob", `blobs/notes/${peer.blob!.digest}`],
    ] as const;
    for (const [operationId, suffix] of capabilities) {
      const operation = schema.http[operationId];
      if (!isJsonObject(operation) || !Array.isArray(operation.errors)) throw new Error(`source errors unavailable: ${operationId}`);
      const declaration = operation.errors.find((value: unknown) => typeof value === "string" && value.startsWith("401 "));
      if (typeof declaration !== "string") throw new Error(`source 401 declaration unavailable: ${operationId}`);
      // Error declarations use the schema's established status + pipe-union grammar.
      const declaredSchema = { anyOf: declaration.slice("401 ".length).split("|").map(name => ({ $ref: `#/$defs/${name}` })) };
      const beforeOwner = peer.trace.length;
      const ownerDenied = await fetch(route(0, suffix), { headers: { "X-Wolfpack-Extension-Peer-Authorization": `Bearer ${peer.token}` } });
      const ownerBody: unknown = await ownerDenied.json();
      expect(ownerDenied.status).toBe(401); expect(ownerBody).toEqual({ error: "unauthorized" });
      expect(peer.trace).toHaveLength(beforeOwner);
      const peerDenied = await fetch(route(0, suffix), { headers: { Authorization: `Bearer ${fixture.localToken}` } });
      const peerBody: unknown = await peerDenied.json();
      expect(peerDenied.status).toBe(401); expect(peerBody).toMatchObject({ error: { code: "PEER_AUTH_REQUIRED" } });
      expect(validateControlApiSchemaValue(declaredSchema, peerBody, schema)).toEqual([]);
      expect(validateControlApiSchemaValue(declaredSchema, ownerBody, schema)).toEqual([]);
      for (const malformed of [{ error: 1 }, { error: { code: "UNKNOWN", message: "invalid" } }, { error: { code: "PEER_AUTH_REQUIRED" } }]) {
        expect(validateControlApiSchemaValue(declaredSchema, malformed, schema).length).toBeGreaterThan(0);
      }
    }
  });
  test("reads installed peer bundles, documents and actual distinct git repositories for the same session UUID", async () => {
    for (let index = 0; index < 2; index++) {
      const peer = fixture.peers[index]!;
      const catalog = peer.runtime.catalog(false).installations[0]!;
      const asset = await fetch(route(index, catalog.ui!.url.slice("/api/extensions/".length)), { headers: headers(index) });
      expect(asset.status).toBe(200); expect(asset.headers.get("x-wolfpack-extension-digest")).toBe(catalog.ui!.digest);
      expect(await asset.text()).toContain(`code ${peer.key}`);
      const doc = await fetch(route(index, `documents/notes/context?session=${SELECTED_HOST_SESSION}`), { headers: headers(index) });
      expect(doc.status).toBe(200); expect(await doc.json()).toMatchObject({ installationId: peer.runtime.installationId, scopeSessionId: SELECTED_HOST_SESSION, extensionId: "notes", documentId: "context", document: `document ${peer.key}` });
      const git = await fetch(route(index, `project/git-status/notes?session=${SELECTED_HOST_SESSION}`), { headers: headers(index) });
      expect(git.status).toBe(200); expect(await git.json()).toMatchObject({ installationId: peer.runtime.installationId, scopeSessionId: SELECTED_HOST_SESSION, status: { state: "ready", branch: `branch-${peer.key}`, untracked: [{ path: `only-${peer.key}.txt` }] } });
    }
  });
  test("reads declared peer blobs as verified octet-streams and refuses undeclared, missing, corrupt or mistyped ones", async () => {
    const peer = fixture.peers[0]!, blob = peer.blob!;
    const ok = await fetch(route(0, `blobs/notes/${blob.digest}`), { headers: headers(0) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/octet-stream");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-wolfpack-blob-digest")).toBe(blob.digest);
    expect(Buffer.from(await ok.arrayBuffer()).equals(blob.bytes)).toBe(true);
    const undeclared = await fetch(route(1, `blobs/notes/${blob.digest}`), { headers: headers(1) });
    expect(undeclared.status).toBe(403); expect(await undeclared.json()).toMatchObject({ error: { code: "PEER_FORBIDDEN" } });
    expect(fixture.peers[1]!.trace.some(value => value.path.includes("/blobs/"))).toBe(false);
    const missing = await fetch(route(0, `blobs/notes/${"f".repeat(64)}`), { headers: headers(0) });
    expect(missing.status).toBe(404); expect(await missing.json()).toMatchObject({ error: { code: "PEER_FORBIDDEN" } });
    const forged: Array<[string, Uint8Array | string]> = [["application/octet-stream", new TextEncoder().encode("corrupt")], ["application/json", JSON.stringify([...blob.bytes])]];
    for (const [type, body] of forged) {
      peer.handleRequest = (req, res, url) => {
        if (!url.pathname.startsWith("/api/extensions/blobs/")) return false;
        res.writeHead(200, { "Content-Type": type }); res.end(body); return true;
      };
      try {
        const response = await fetch(route(0, `blobs/notes/${blob.digest}`), { headers: headers(0) });
        expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "PEER_RESPONSE_INVALID" } });
      } finally { peer.handleRequest = undefined; }
    }
    // The declared maxBlobBytes (4096 for peer a) caps the read even when the bytes would hash correctly.
    const oversize = new Uint8Array(4097).fill(7), oversizeDigest = createHash("sha256").update(oversize).digest("hex");
    for (const declareLength of [true, false]) {
      peer.handleRequest = (req, res, url) => {
        if (!url.pathname.startsWith("/api/extensions/blobs/")) return false;
        res.writeHead(200, { "Content-Type": "application/octet-stream", ...(declareLength ? { "Content-Length": oversize.byteLength } : {}) }); res.end(oversize); return true;
      };
      try {
        const response = await fetch(route(0, `blobs/notes/${oversizeDigest}`), { headers: headers(0) });
        expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "PEER_RESPONSE_INVALID" } });
      } finally { peer.handleRequest = undefined; }
    }
    for (const suffix of [`blobs/notes/${blob.digest}?session=${SELECTED_HOST_SESSION}`, `blobs/notes/${blob.digest.toUpperCase()}`, `blobs/notes/${blob.digest.slice(1)}`]) {
      expect((await fetch(route(0, suffix), { headers: headers(0) })).status).toBe(400);
    }
  });
  test("rejects absent/wrong peer auth without exposing private upstream text, cookies or headers", async () => {
    const missing = await fetch(route(0), { headers: { Authorization: `Bearer ${fixture.localToken}` } });
    expect(missing.status).toBe(401); expect(await missing.json()).toMatchObject({ error: { code: "PEER_AUTH_REQUIRED" } });
    const wrong = await fetch(route(0), { headers: { ...headers(0), "X-Wolfpack-Extension-Peer-Authorization": `Bearer ${fixture.localToken}` } });
    expect(wrong.status).toBe(401); expect(await wrong.json()).toMatchObject({ error: { code: "PEER_AUTH_REQUIRED" } });
    const peer = fixture.peers[0]!; peer.mode = "error-secret";
    try {
      const denied = await fetch(route(0), { headers: headers(0) });
      expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("SECRET");
      expect(denied.headers.get("set-cookie")).toBeNull(); expect(denied.headers.get("x-private")).toBeNull();
    } finally { peer.mode = "normal"; }
  });
  test("does not fall back locally for offline or changed installation identity", async () => {
    const peer = fixture.peers[0]!; const before = peer.trace.length;
    peer.online = false; fixture.updateTopology();
    try { const value = await fetch(route(0), { headers: headers(0) }); expect(value.status).toBe(503); expect(peer.trace).toHaveLength(before); }
    finally { peer.online = true; fixture.updateTopology(); }
    const beforeIdentity = peer.trace.length;
    peer.mode = "wrong-identity";
    try {
      const value = await fetch(route(0), { headers: headers(0) }); expect(value.status).toBe(409); expect(await value.json()).toMatchObject({ error: { code: "PEER_INCOMPATIBLE" } });
      expect(peer.trace.slice(beforeIdentity)).toEqual([{ path: "/api/machine", authorization: undefined, cookie: undefined, peerHeader: undefined }]);
    }
    finally { peer.mode = "normal"; }
  });
  test("honors advertised peer safe mode and installed enablement before all code/data capabilities", async () => {
    const peer = fixture.peers[0]!, item = peer.runtime.catalog(false).installations[0]!;
    peer.safeMode = true;
    try {
      const catalog = await fetch(route(0), { headers: headers(0) }); expect(catalog.status).toBe(200); expect(await catalog.json()).toMatchObject({ safeMode: true });
      for (const suffix of [item.ui!.url.slice("/api/extensions/".length), `documents/notes/context?session=${SELECTED_HOST_SESSION}`, `project/git-status/notes?session=${SELECTED_HOST_SESSION}`]) expect((await fetch(route(0, suffix), { headers: headers(0) })).status).toBe(403);
    } finally { peer.safeMode = false; }
    peer.runtime.setEnabled("notes", false);
    try { expect((await fetch(route(0, `documents/notes/context?session=${SELECTED_HOST_SESSION}`), { headers: headers(0) })).status).toBe(403); }
    finally { peer.runtime.setEnabled("notes", true); }
  });
  test("rejects write/open-proxy/query aliases before any peer access", async () => {
    const before = fixture.fetchTrace.length;
    const suffixes = ["catalog?origin=https://evil.invalid", "https://evil.invalid/", "documents/notes/context?session=" + SELECTED_HOST_SESSION + "&path=/tmp", "documents/notes/context?session=" + SELECTED_HOST_SESSION + "&session=" + SELECTED_HOST_SESSION, "project/git-status/notes?session=by-name", "assets/notes/" + "a".repeat(64) + "/dist//ui.js", "assets/notes/" + "a".repeat(64) + "/dist/%252e%252e/ui.js"];
    for (const suffix of suffixes) expect((await fetch(route(0, suffix), { headers: headers(0) })).status).toBe(400);
    expect((await fetch(route(0), { method: "POST", headers: headers(0), body: "{}" })).status).toBe(405);
    expect(fixture.fetchTrace).toHaveLength(before);
  });
  test("rejects identity or topology authority lost after a successful upstream catalog", async () => {
    const peer = fixture.peers[0]!;
    peer.afterCatalog = () => { peer.mode = "wrong-identity"; };
    try { const value = await fetch(route(0), { headers: headers(0) }); expect(value.status).toBe(409); expect(await value.json()).toMatchObject({ error: { code: "PEER_INCOMPATIBLE" } }); }
    finally { peer.afterCatalog = undefined; peer.mode = "normal"; }
    peer.afterCatalog = () => { peer.online = false; fixture.updateTopology(); };
    try { const value = await fetch(route(0), { headers: headers(0) }); expect(value.status).toBe(503); expect(await value.json()).toMatchObject({ error: { code: "PEER_UNAVAILABLE" } }); }
    finally { peer.afterCatalog = undefined; peer.online = true; fixture.updateTopology(); }
  });
  test("bounds concurrent work and cancels actual upstream acquisition on client disconnect", async () => {
    const peer = fixture.peers[0]!; peer.mode = "stalled";
    const firstController = new AbortController(), secondController = new AbortController();
    const first = fetch(route(0), { headers: headers(0), signal: firstController.signal }).catch(() => null);
    const second = fetch(route(0), { headers: headers(0), signal: secondController.signal }).catch(() => null);
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = performance.now();
      while (peer.stalled.length < 2 && performance.now() - started < 150) await new Promise(resolve => setTimeout(resolve, 2));
      expect(peer.stalled).toHaveLength(2);
      const overloaded = await fetch(route(0), { headers: headers(0) });
      expect(overloaded.status).toBe(503); expect(await overloaded.json()).toMatchObject({ error: { code: "PEER_BUSY" } });
      const closed = Promise.race([
        Promise.any(peer.stalled.map(response => new Promise<boolean>(resolve => response.once("close", () => resolve(true))))),
        new Promise<boolean>(resolve => { guard = setTimeout(() => resolve(false), 150); }),
      ]);
      firstController.abort(); expect(await closed).toBe(true);
      peer.mode = "normal";
      expect((await fetch(route(0), { headers: headers(0) })).status).toBe(200);
    } finally { clearTimeout(guard); firstController.abort(); secondController.abort(); peer.mode = "normal"; for (const response of peer.stalled.splice(0)) response.end(); await Promise.all([first, second]); }
  });
  test("bounds chunked catalogs, redirects and stalled upstream bodies with typed failures", async () => {
    const peer = fixture.peers[0]!;
    // Prove the owned target really receives native HTTP, not only adapter entries.
    expect((await fetch(`${fixture.redirectBase}/target-health`)).status).toBe(200);
    expect(fixture.redirectTrace).toEqual(["/target-health"]);
    for (const mode of ["oversized", "redirect", "stalled"] as const) {
      peer.mode = mode;
      try {
        const started = performance.now();
        const result = await fetch(route(0), { headers: headers(0) });
        expect(result.status).toBe(503); expect(await result.json()).toHaveProperty("error.code");
        expect(performance.now() - started).toBeLessThan(1500);
        expect(fixture.redirectTrace).toEqual(["/target-health"]);
        expect(fixture.redirectTrace.filter(path => path === "/unexpected-redirect")).toHaveLength(0);
      } finally { peer.mode = "normal"; for (const response of peer.stalled.splice(0)) response.end(); }
    }
  });
});
