import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIRECTORY_BROWSE_LIMIT,
  DIRECTORY_BROWSE_SCAN_LIMIT,
  browseServerDirectory,
} from "../../src/server/directory-browser.ts";
import { __setTestBackend } from "../../src/server/backend.js";
import { MockBackend } from "../../src/server/mock-backend.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-directory-browser-")));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("browseServerDirectory", () => {
  test("canonicalizes the current directory and returns its canonical parent", () => {
    const parent = join(root, "canonical-parent");
    const current = join(parent, "current");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(current, { recursive: true });
    symlinkSync(parent, linkedParent);

    expect(browseServerDirectory(join(linkedParent, "current"))).toEqual({
      ok: true,
      value: {
        current: realpathSync(current),
        parent: realpathSync(parent),
        directories: [],
      },
    });
  });

  test("returns only sorted non-hidden real child directories and bounds the response", () => {
    const current = join(root, "listing");
    const linkedTarget = join(root, "linked-target");
    mkdirSync(current);
    mkdirSync(linkedTarget);
    mkdirSync(join(current, ".hidden"));
    writeFileSync(join(current, "file.txt"), "not a directory");
    symlinkSync(linkedTarget, join(current, "linked-directory"));
    for (let index = DIRECTORY_BROWSE_LIMIT + 2; index >= 0; index--) {
      mkdirSync(join(current, `directory-${String(index).padStart(3, "0")}`));
    }

    const result = browseServerDirectory(current);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.directories).toHaveLength(DIRECTORY_BROWSE_LIMIT);
    expect(result.value.directories[0]).toEqual({
      name: "directory-000",
      path: realpathSync(join(current, "directory-000")),
    });
    expect(result.value.directories.at(-1)?.name).toBe(
      `directory-${String(DIRECTORY_BROWSE_LIMIT - 1).padStart(3, "0")}`,
    );
    expect(result.value.directories.map(directory => directory.name)).not.toContain(".hidden");
    expect(result.value.directories.map(directory => directory.name)).not.toContain("file.txt");
    expect(result.value.directories.map(directory => directory.name)).not.toContain("linked-directory");
  });

  test("fails after a finite raw-entry scan even when entries cannot be returned", () => {
    const current = join(root, "scan-overflow");
    mkdirSync(current);
    for (let index = 0; index <= DIRECTORY_BROWSE_SCAN_LIMIT; index++) {
      const prefix = index % 2 === 0 ? ".hidden-file" : "file";
      writeFileSync(join(current, `${prefix}-${index}`), "not a directory");
    }

    expect(browseServerDirectory(current)).toEqual({
      ok: false,
      code: "too_many_entries",
      error: "directory contains too many entries",
    });
  });

  test("represents the filesystem root without a parent", () => {
    const result = browseServerDirectory("/");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current).toBe(realpathSync("/"));
    expect(result.value.parent).toBeNull();
    expect(result.value.directories.length).toBeLessThanOrEqual(DIRECTORY_BROWSE_LIMIT);
  });

  test("returns bounded structured failures for invalid, missing, and unavailable directories", () => {
    const loop = join(root, "loop");
    symlinkSync("loop", loop);

    expect(browseServerDirectory("relative/path")).toEqual({
      ok: false,
      code: "invalid",
      error: "invalid directory",
    });
    expect(browseServerDirectory(join(root, "missing"))).toEqual({
      ok: false,
      code: "not_found",
      error: "directory not found",
    });
    expect(browseServerDirectory(join(loop, "child"))).toEqual({
      ok: false,
      code: "unavailable",
      error: "directory unavailable",
    });
  });
});

describe("GET /api/directories", () => {
  let server: ReturnType<typeof import("node:http").createServer>;
  let baseUrl: string;
  const configuredBase = join(root, "configured-base");
  const mockBackend = new MockBackend();

  beforeAll(async () => {
    process.env.WOLFPACK_TEST = "1";
    process.env.WOLFPACK_DEV_DIR = configuredBase;
    const { __setDevDir } = await import("../../src/server/dev-dir.js");
    __setDevDir(configuredBase);
    __setTestBackend(mockBackend);
    mkdirSync(join(configuredBase, "project"), { recursive: true });
    const { createServerInstance } = await import("../../src/server/index.ts");
    ({ server } = createServerInstance());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  test("starts at the configured project base when path is omitted", async () => {
    const response = await fetch(`${baseUrl}/api/directories`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      current: realpathSync(configuredBase),
      parent: realpathSync(root),
      directories: [{
        name: "project",
        path: realpathSync(join(configuredBase, "project")),
      }],
    });
  });

  test("navigates by canonical server path and maps structured failures to status codes", async () => {
    const project = realpathSync(join(configuredBase, "project"));
    const success = await fetch(`${baseUrl}/api/directories?path=${encodeURIComponent(project)}`);
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ current: project });

    const invalid = await fetch(`${baseUrl}/api/directories?path=relative`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid directory", code: "invalid" });

    const missing = await fetch(`${baseUrl}/api/directories?path=${encodeURIComponent(join(root, "absent"))}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "directory not found", code: "not_found" });
  });

  test("maps scan overflow to the exact bounded route failure", async () => {
    const current = join(root, "route-scan-overflow");
    mkdirSync(current);
    for (let index = 0; index <= DIRECTORY_BROWSE_SCAN_LIMIT; index++) {
      writeFileSync(join(current, `.hidden-file-${index}`), "not a directory");
    }

    const response = await fetch(
      `${baseUrl}/api/directories?path=${encodeURIComponent(current)}`,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "directory contains too many entries",
      code: "too_many_entries",
    });
  });

  test("creates a named project beneath a validated explicit parent", async () => {
    const parent = join(root, "selected-parent");
    mkdirSync(parent);

    const response = await fetch(`${baseUrl}/api/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newProject: "new-child",
        newProjectParent: parent,
        cmd: "shell",
        sessionName: "explicit-parent-session",
      }),
    });

    expect(response.status).toBe(200);
    expect(mockBackend.lastCreateArgs?.cwd).toBe(realpathSync(join(parent, "new-child")));
  });

  test("keeps configured-base creation when an explicit parent is omitted", async () => {
    const response = await fetch(`${baseUrl}/api/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newProject: "base-child",
        cmd: "shell",
        sessionName: "base-parent-session",
      }),
    });

    expect(response.status).toBe(200);
    expect(mockBackend.lastCreateArgs?.cwd).toBe(realpathSync(join(configuredBase, "base-child")));
  });

  test("rejects invalid explicit parents and impossible selector combinations", async () => {
    const cases = [
      { body: { newProject: "child", newProjectParent: "relative" }, status: 400 },
      { body: { newProject: "child", newProjectParent: join(root, "missing-parent") }, status: 404 },
      { body: { project: "project", newProjectParent: configuredBase }, status: 400 },
      { body: { projectDir: configuredBase, newProject: "child", newProjectParent: configuredBase }, status: 400 },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/api/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.body),
      });
      expect(response.status).toBe(entry.status);
    }
  });
});
