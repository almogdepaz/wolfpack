import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Dirent,
  chmodSync,
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
  DIRECTORY_BREADCRUMB_LIMIT,
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
        breadcrumbs: expect.any(Array),
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
    expect(result.value.breadcrumbs.at(-1)).toEqual({
      name: "listing",
      path: realpathSync(current),
    });
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

  test("bounds canonical breadcrumbs while preserving root, an ancestor jump, and the current directory", () => {
    let current = join(root, "deep-breadcrumbs");
    for (let index = 0; index < DIRECTORY_BREADCRUMB_LIMIT + 5; index++) {
      current = join(current, `level-${index}`);
    }
    mkdirSync(current, { recursive: true });

    const result = browseServerDirectory(current);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.breadcrumbs).toHaveLength(DIRECTORY_BREADCRUMB_LIMIT);
    expect(result.value.breadcrumbs[0]).toEqual({ name: "/", path: "/" });
    expect(result.value.breadcrumbs[1]?.name).toBe("…");
    expect(result.value.breadcrumbs[1]?.path).not.toBe(result.value.current);
    expect(result.value.breadcrumbs.at(-1)).toEqual({
      name: `level-${DIRECTORY_BREADCRUMB_LIMIT + 4}`,
      path: realpathSync(current),
    });
  });

  test("uses lstat when directory entry type metadata is unknown", () => {
    const current = join(root, "unknown-entry-type");
    const child = join(current, "real-directory");
    mkdirSync(child, { recursive: true });
    const originalIsDirectory = Dirent.prototype.isDirectory;

    try {
      Dirent.prototype.isDirectory = () => false;
      expect(browseServerDirectory(current)).toEqual({
        ok: true,
        value: {
          current: realpathSync(current),
          parent: realpathSync(root),
          breadcrumbs: expect.any(Array),
          directories: [{
            name: "real-directory",
            path: realpathSync(child),
          }],
        },
      });
    } finally {
      Dirent.prototype.isDirectory = originalIsDirectory;
    }
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
    expect(result.value.breadcrumbs).toEqual([{ name: "/", path: "/" }]);
    expect(result.value.directories.length).toBeLessThanOrEqual(DIRECTORY_BROWSE_LIMIT);
  });

  test("returns bounded structured failures for invalid, missing, permission-denied, and unavailable directories", () => {
    const loop = join(root, "loop");
    const denied = join(root, "permission-denied");
    symlinkSync("loop", loop);
    mkdirSync(denied);
    chmodSync(denied, 0);

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
    try {
      expect(browseServerDirectory(denied)).toEqual({
        ok: false,
        code: "permission_denied",
        error: "directory permission denied",
      });
    } finally {
      chmodSync(denied, 0o700);
    }
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
      breadcrumbs: expect.any(Array),
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

    const deniedPath = join(root, "route-permission-denied");
    mkdirSync(deniedPath);
    chmodSync(deniedPath, 0);
    try {
      const denied = await fetch(`${baseUrl}/api/directories?path=${encodeURIComponent(deniedPath)}`);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: "directory permission denied",
        code: "permission_denied",
      });
    } finally {
      chmodSync(deniedPath, 0o700);
    }
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

    expect(response.status).toBe(422);
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
