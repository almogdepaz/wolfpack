import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readProcessStartTime } from "../../src/extensions/registry-lock.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";
import { fixture } from "./fixtures/extension-transaction-package.ts";

const hostId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), "wolfpack-extension-transaction-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

function stages(runtime: ExtensionRuntime) {
  return readdirSync(join(runtime.root, "snapshots")).filter((name) =>
    name.startsWith(".stage-"),
  );
}

async function installNpm(
  runtime: ExtensionRuntime,
  requested: string,
  actual: { name: string; version: string; id: string },
  skillsRoot: string,
) {
  const source = fixture(root(), actual.version, actual.id, actual.name);
  const archive = join(root(), "package.tgz");
  await tar.c({ file: archive, cwd: source, prefix: "package", gzip: true }, [
    "package.json",
    "dist",
  ]);
  const bytes = await Bun.file(archive).arrayBuffer();
  const integrity = `sha512-${createHash("sha512").update(Buffer.from(bytes)).digest("base64")}`;
  let registry!: ReturnType<typeof Bun.serve>;
  registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/package.tgz")
        return new Response(bytes);
      const [name, version] =
        requested.slice(4).lastIndexOf("@") > 0
          ? [
              requested.slice(4, requested.lastIndexOf("@")),
              requested.slice(requested.lastIndexOf("@") + 1),
            ]
          : ["", ""];
      return Response.json({
        name,
        version,
        dist: { tarball: `${registry.url.origin}/package.tgz`, integrity },
      });
    },
  });
  try {
    return await runtime.install({
      source: requested,
      registryUrl: registry.url.origin,
      trustBrowserCode: true,
      skillsRoot,
    });
  } finally {
    await registry.stop(true);
  }
}

describe("extension snapshot transactions", () => {
  test("BUSY leaves current, previous, removed-retained snapshots and no operation stage untouched", async () => {
    const base = root();
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const v1 = fixture(base, "1.0.0");
    const first = await runtime.install({ source: v1, trustBrowserCode: true });
    const v2 = fixture(base, "1.0.1");
    const second = await runtime.install({
      source: v2,
      trustBrowserCode: true,
    });
    const busyInstall = async (source: string) => {
      mkdirSync(join(runtime.root, ".registry-lock"));
      try {
        await expect(
          runtime.install({ source, trustBrowserCode: true }),
        ).rejects.toMatchObject({ code: "BUSY" });
      } finally {
        rmSync(join(runtime.root, ".registry-lock"), {
          recursive: true,
          force: true,
        });
      }
    };
    await busyInstall(v2);
    expect(
      runtime.asset("fixture", second.installation.package.digest, "dist/ui.js")
        .bytes.byteLength,
    ).toBeGreaterThan(0);
    expect({
      current: existsSync(second.installation.snapshot),
      previous: existsSync(first.installation.snapshot),
      stages: stages(runtime),
    }).toEqual({ current: true, previous: true, stages: [] });
    // v1 is the active installation's retained previous digest, not merely a removed record.
    await busyInstall(v1);
    expect(runtime.catalog().installations).toHaveLength(1);
    expect(runtime.rollback("fixture").package.version).toBe("1.0.0");
    expect(
      runtime.asset("fixture", first.installation.package.digest, "dist/ui.js")
        .bytes.byteLength,
    ).toBeGreaterThan(0);
    expect(runtime.rollback("fixture").package.version).toBe("1.0.1");
    runtime.remove("fixture");
    await busyInstall(v1);
    expect(runtime.catalog().installations).toEqual([]);
    expect({
      current: existsSync(second.installation.snapshot),
      previous: existsSync(first.installation.snapshot),
      stages: stages(runtime),
    }).toEqual({ current: true, previous: true, stages: [] });
  });

  test("overlapping same-digest installs retain the winning snapshot when the first publication fails", async () => {
    const base = root();
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const source = fixture(base);
    const seam = runtime as any,
      save = seam.save.bind(runtime);
    const primary = new Error("first transaction fails before commit");
    let calls = 0;
    seam.save = (value: unknown) => {
      if (++calls === 1) throw primary;
      save(value);
    };
    const outcomes = await Promise.allSettled([
      runtime.install({ source, trustBrowserCode: true }),
      runtime.install({ source, trustBrowserCode: true }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect((outcomes[0] as PromiseRejectedResult).reason).toBe(primary);
    const installed = (outcomes[1] as PromiseFulfilledResult<any>).value
      .installation;
    expect(readdirSync(join(runtime.root, "snapshots"))).toEqual([
      installed.package.digest,
    ]);
    expect(stages(runtime)).toEqual([]);
    expect(
      runtime.asset("fixture", installed.package.digest, "dist/ui.js").bytes
        .byteLength,
    ).toBeGreaterThan(0);
  });

  test("save failure preserves the original error and uses the authoritative registry to distinguish pre-, post-, and unknown commit state", async () => {
    const installWith = async (mode: "pre" | "post" | "unknown") => {
      const base = root();
      const runtime = new ExtensionRuntime({
        root: join(base, `runtime-${mode}`),
        installationId: hostId,
      });
      const source = fixture(base);
      const seam = runtime as any,
        save = seam.save.bind(runtime);
      const primary = new Error(`${mode} save failure`);
      seam.save = (value: unknown) => {
        if (mode !== "pre") save(value);
        if (mode === "unknown")
          writeFileSync(join(runtime.root, "registry.json"), "not json");
        throw primary;
      };
      await expect(
        runtime.install({ source, trustBrowserCode: true }),
      ).rejects.toBe(primary);
      return { runtime, primary };
    };
    const pre = await installWith("pre");
    expect(readdirSync(join(pre.runtime.root, "snapshots"))).toEqual([]);
    expect(pre.runtime.catalog().installations).toEqual([]);
    const post = await installWith("post");
    expect(post.runtime.catalog().installations).toHaveLength(1);
    const postEntry = post.runtime.catalog().installations[0]!;
    expect(
      post.runtime.asset(
        postEntry.extensionId,
        postEntry.package.digest,
        "dist/ui.js",
      ).bytes.byteLength,
    ).toBeGreaterThan(0);
    const unknown = await installWith("unknown");
    expect(readdirSync(join(unknown.runtime.root, "snapshots"))).toHaveLength(
      1,
    );
    expect(() => unknown.runtime.catalog()).toThrow("coherent owned registry");
  });

  test("cleanup diagnostics cannot replace frozen or already decorated errors", () => {
    const runtime = new ExtensionRuntime({
      root: join(root(), "runtime"),
      installationId: hostId,
    });
    const retain = (runtime as any).retainCleanupFailure.bind(runtime);
    const frozen = Object.freeze(new Error("original"));
    expect(() => retain(frozen, new Error("cleanup"))).not.toThrow();
    const decorated = new Error("original");
    Object.defineProperty(decorated, "cleanupFailure", {
      value: new Error("first"),
      configurable: false,
    });
    expect(() => retain(decorated, new Error("second"))).not.toThrow();
  });
});

describe("registry lock ownership", () => {
  function selfStartTime() {
    const value = readProcessStartTime(process.pid);
    expect(value).toBeDefined();
    return value!;
  }
  function locked(owner?: unknown) {
    const base = root();
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const source = fixture(base);
    const lock = join(runtime.root, ".registry-lock");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    if (owner !== undefined)
      writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
      });
    return { runtime, source, lock };
  }
  test("live owner remains BUSY with pid and lock diagnosis", async () => {
    const owner = { pid: process.pid, startTime: selfStartTime() };
    const { runtime, source, lock } = locked(owner);
    const attempt = runtime.install({ source, trustBrowserCode: true });
    await expect(attempt).rejects.toMatchObject({ code: "BUSY" });
    await expect(attempt).rejects.toThrow(`pid ${process.pid}`);
    await expect(attempt).rejects.toThrow(lock);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(
      owner,
    );
  });
  test("a competing recovery cannot expose a live writer's lock to a third writer", () => {
    const dead = Bun.spawnSync(["true"]);
    const { runtime, lock } = locked({
      pid: dead.pid,
      startTime: "exited fixture",
    });
    const transaction = (fn: () => void) =>
      (runtime as unknown as { withLock(fn: () => void): void }).withLock(fn);
    const rename = fs.renameSync;
    let interleaved = false;
    let thirdEntered = false;
    let thirdError: unknown;
    let competingError: unknown;
    // Pause recovery A at its rename. Recovery B wins and enters its real
    // critical section, then A's original rename resumes before verification.
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!interleaved && from === lock) {
        interleaved = true;
        try {
          transaction(() => {
            rename(from, to);
            try {
              transaction(() => {
                thirdEntered = true;
              });
            } catch (error) {
              thirdError = error;
            }
          });
        } catch (error) {
          competingError = error;
          rename(from, to);
          try {
            transaction(() => {
              thirdEntered = true;
            });
          } catch (error) {
            thirdError = error;
          }
        }
        return;
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      let recoveryError: unknown;
      try {
        transaction(() => {});
      } catch (error) {
        recoveryError = error;
      }
      expect(interleaved).toBe(true);
      expect(thirdEntered).toBe(false);
      expect(thirdError).toMatchObject({ code: "BUSY" });
      expect(competingError).toMatchObject({ code: "BUSY" });
      expect(recoveryError).toBeUndefined();
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });
  test.each(["missing", "partial", "dead", "live"])(
    "%s recovery owner always fails closed",
    async (kind) => {
      const child = Bun.spawnSync(["true"]);
      for (const canonicalExists of [true, false]) {
        const { runtime, source, lock } = locked({
          pid: child.pid,
          startTime: "exited fixture",
        });
        if (!canonicalExists) rmSync(lock, { recursive: true });
        const recovery = `${lock}.recovery`;
        mkdirSync(recovery, { mode: 0o700 });
        if (kind !== "missing")
          writeFileSync(
            join(recovery, "owner.json"),
            kind === "partial"
              ? "{partial"
              : JSON.stringify({
                  pid: kind === "live" ? process.pid : child.pid,
                  startTime:
                    kind === "live" ? selfStartTime() : "exited fixture",
                }),
            { mode: 0o600 },
          );
        const attempt = runtime.install({ source, trustBrowserCode: true });
        await expect(attempt).rejects.toMatchObject({ code: "BUSY" });
        await expect(attempt).rejects.toThrow(lock);
        await expect(attempt).rejects.toThrow(recovery);
        await expect(attempt).rejects.toThrow("remove it manually");
        expect(existsSync(recovery)).toBe(true);
        expect(existsSync(lock)).toBe(canonicalExists);
      }
    },
  );
  test("canonical ownership is rechecked after recovery guard acquisition", () => {
    const dead = Bun.spawnSync(["true"]);
    const { runtime, lock } = locked({
      pid: dead.pid,
      startTime: "exited fixture",
    });
    const live = { pid: process.pid, startTime: selfStartTime() };
    const mkdir = fs.mkdirSync,
      rename = fs.renameSync;
    let retirements = 0;
    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(((
      path: fs.PathLike,
      options: fs.MakeDirectoryOptions,
    ) => {
      const result = mkdir(path, options);
      if (path === `${lock}.recovery`)
        writeFileSync(join(lock, "owner.json"), JSON.stringify(live));
      return result;
    }) as typeof fs.mkdirSync);
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (from === lock) retirements++;
      rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      expect(() => runtime.remove("fixture")).toThrow(`pid ${process.pid}`);
      expect(retirements).toBe(0);
      expect(
        JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")),
      ).toEqual(live);
      expect(existsSync(`${lock}.recovery`)).toBe(false);
    } finally {
      mkdirSpy.mockRestore();
      renameSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });
  test("an alive but unverifiable owner remains BUSY", async () => {
    const pid = 2147483000;
    const { runtime, source, lock } = locked({ pid, startTime: "unavailable" });
    const kill = process.kill;
    const spy = spyOn(process, "kill").mockImplementation((value, signal) => {
      if (value === pid)
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return kill(value, signal);
    });
    try {
      await expect(
        runtime.install({ source, trustBrowserCode: true }),
      ).rejects.toMatchObject({ code: "BUSY" });
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(`${lock}.recovery`)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  test("release preserves a replaced owner record", () => {
    const base = root(),
      lock = join(base, "runtime", ".registry-lock");
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const replacement = { pid: process.pid, startTime: "replacement identity" };
    (runtime as unknown as { withLock(fn: () => void): void }).withLock(() => {
      writeFileSync(join(lock, "owner.json"), JSON.stringify(replacement));
    });
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(
      replacement,
    );
  });
  test.each(["ownerless", "published", "retired"])(
    "crash with %s recovery guard requires manual recovery",
    async (state) => {
      const base = root();
      const runtime = new ExtensionRuntime({
        root: join(base, "runtime"),
        installationId: hostId,
      });
      const source = fixture(base);
      await runtime.install({ source, trustBrowserCode: true });
      const lock = join(runtime.root, ".registry-lock"),
        recovery = `${lock}.recovery`;
      const dead = Bun.spawnSync(["true"]);
      mkdirSync(lock);
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: dead.pid, startTime: "exited fixture" }),
      );
      for (const name of ["home", "zdotdir", "state"])
        mkdirSync(join(base, name));
      const child = spawnSync(
        process.execPath,
        [
          "--preload",
          join(import.meta.dirname, "fixtures/fs-crash-preload.ts"),
          join(
            import.meta.dirname,
            "fixtures/extension-registry-crash-child.ts",
          ),
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            HOME: join(base, "home"),
            ZDOTDIR: join(base, "zdotdir"),
            WOLFPACK_DIR: join(base, "state"),
            WOLFPACK_TEST: "1",
            ENV: undefined,
            BASH_ENV: undefined,
            WP_CRASH_ROOT: runtime.root,
            WP_CRASH_SOURCE: source,
            WP_CRASH_OP: "remove",
            WP_CRASH_AT: "500",
            WP_CRASH_RECOVERY_STATE: state,
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBe("SIGKILL");
      expect(existsSync(recovery)).toBe(true);
      expect(existsSync(join(recovery, "owner.json"))).toBe(
        state !== "ownerless",
      );
      const attempt = runtime.install({ source, trustBrowserCode: true });
      await expect(attempt).rejects.toMatchObject({ code: "BUSY" });
      await expect(attempt).rejects.toThrow(recovery);
      await expect(attempt).rejects.toThrow("remove it manually");
      expect(existsSync(lock)).toBe(state !== "retired");
      expect(existsSync(recovery)).toBe(true);
    },
  );
  test("published dead owner is cleared without leaving a stale directory", async () => {
    const child = Bun.spawnSync(["true"]);
    expect(child.exitCode).toBe(0);
    const { runtime, source, lock } = locked({
      pid: child.pid,
      startTime: "exited fixture",
    });
    await expect(
      runtime.install({ source, trustBrowserCode: true }),
    ).resolves.toHaveProperty("installation");
    expect(existsSync(lock)).toBe(false);
    expect(
      readdirSync(runtime.root).filter((name) =>
        name.startsWith(".registry-lock"),
      ),
    ).toEqual([]);
  });
  test("reused pid with a different published start time is cleared", async () => {
    const { runtime, source, lock } = locked({
      pid: process.pid,
      startTime: `${selfStartTime()}-different`,
    });
    await expect(
      runtime.install({ source, trustBrowserCode: true }),
    ).resolves.toHaveProperty("installation");
    expect(existsSync(lock)).toBe(false);
    expect(
      readdirSync(runtime.root).filter((name) =>
        name.startsWith(".registry-lock"),
      ),
    ).toEqual([]);
  });
  test.each(["missing", "partial"])(
    "%s owner record stays BUSY with manual guidance",
    async (kind) => {
      const { runtime, source, lock } = locked();
      if (kind === "partial")
        writeFileSync(join(lock, "owner.json"), "{partial", { mode: 0o600 });
      const attempt = runtime.install({ source, trustBrowserCode: true });
      await expect(attempt).rejects.toMatchObject({ code: "BUSY" });
      await expect(attempt).rejects.toThrow(lock);
      await expect(attempt).rejects.toThrow("remove it manually");
      expect(existsSync(lock)).toBe(true);
    },
  );
  test("a killed transaction retains the published child owner record", async () => {
    const base = root();
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const source = fixture(base);
    await runtime.install({ source, trustBrowserCode: true });
    for (const name of ["home", "zdotdir", "state"])
      mkdirSync(join(base, name));
    const child = spawnSync(
      process.execPath,
      [
        "--preload",
        join(import.meta.dirname, "fixtures/fs-crash-preload.ts"),
        join(import.meta.dirname, "fixtures/extension-registry-crash-child.ts"),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          HOME: join(base, "home"),
          ZDOTDIR: join(base, "zdotdir"),
          WOLFPACK_DIR: join(base, "state"),
          WOLFPACK_TEST: "1",
          ENV: undefined,
          BASH_ENV: undefined,
          WP_CRASH_ROOT: runtime.root,
          WP_CRASH_SOURCE: source,
          WP_CRASH_OP: "remove",
          WP_CRASH_AT: "7",
        },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGKILL");
    const ownerPath = join(runtime.root, ".registry-lock", "owner.json");
    expect(existsSync(ownerPath)).toBe(true);
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    expect(owner.pid).toBe(child.pid);
    expect(typeof owner.startTime).toBe("string");
    expect(owner.startTime.length).toBeGreaterThan(0);
  });
});

describe("exact npm manifest identity", () => {
  test("cleans a copied private stage and later acquisition resources when extraction cleanup fails", async () => {
    const base = root();
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const skills = join(base, "skills");
    mkdirSync(skills);
    const seam = runtime as any,
      cleanup = seam.cleanupTree.bind(runtime);
    const primary = new Error("injected extraction cleanup failure");
    seam.cleanupTree = (path: string, message: string) => {
      if (path.includes(".extension-stage-")) throw primary;
      cleanup(path, message);
    };
    await expect(
      installNpm(
        runtime,
        "npm:expected@1.0.0",
        { name: "expected", version: "1.0.0", id: "expected" },
        skills,
      ),
    ).rejects.toBe(primary);
    expect(stages(runtime)).toEqual([]);
    expect(readdirSync(join(runtime.root, "acquisition"))).toEqual([]);
  });

  test("rejects name, version, and scoped-name mismatches without changing the registry, skills, or private stages", async () => {
    const base = root();
    const runtime = new ExtensionRuntime({
      root: join(base, "runtime"),
      installationId: hostId,
    });
    const skills = join(base, "skills");
    mkdirSync(skills);
    writeFileSync(join(skills, "sentinel"), "unchanged");
    const valid = await installNpm(
      runtime,
      "npm:@scope/expected@1.0.0",
      { name: "@scope/expected", version: "1.0.0", id: "expected" },
      skills,
    );
    const catalog = runtime.catalog();
    const snapshots = readdirSync(join(runtime.root, "snapshots"));
    for (const mismatch of [
      ["npm:expected@1.0.0", { name: "other", version: "1.0.0", id: "other" }],
      [
        "npm:expected@1.0.0",
        { name: "expected", version: "2.0.0", id: "other" },
      ],
      [
        "npm:@scope/expected@1.0.0",
        { name: "@scope/other", version: "1.0.0", id: "other" },
      ],
    ] as const)
      await expect(
        installNpm(runtime, mismatch[0], mismatch[1], skills),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(runtime.catalog()).toEqual(catalog);
    expect(valid.installation.package).toMatchObject({
      name: "@scope/expected",
      version: "1.0.0",
    });
    expect({
      snapshots: readdirSync(join(runtime.root, "snapshots")),
      stages: stages(runtime),
      acquisition: readdirSync(join(runtime.root, "acquisition")),
      skills: readdirSync(skills),
    }).toEqual({
      snapshots,
      stages: [],
      acquisition: [],
      skills: ["sentinel"],
    });
  });
});
