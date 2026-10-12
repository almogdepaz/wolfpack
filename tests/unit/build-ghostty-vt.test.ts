import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GHOSTTY_PATCHES,
  copyGhosttyHeaders,
  createBundleManifest,
  ghosttyArchiveDefinedLibcAllocators,
  ghosttyArchiveHasHostMemsetOverride,
  ghosttyBuildArgs,
  ghosttyPatchArgs,
  readGhosttyLock,
  runGhosttySourceBuild,
  verifyBundleManifest,
} from "../../scripts/build-ghostty-vt.ts";

function withBundle(run: (bundleDir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ghostty-vt-bundle-"));
  try {
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "include", "ghostty"), { recursive: true });
    writeFileSync(join(dir, "lib", "libghostty-vt.a"), "archive-v1");
    writeFileSync(join(dir, "include", "ghostty", "vt.h"), "/* header-v1 */\n");
    const manifest = createBundleManifest("aarch64-apple-darwin", dir);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const builderSource = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "build-ghostty-vt.ts"), "utf8");

describe("libghostty-vt prebuild arguments", () => {
  test("macOS archive builds explicitly suppress XCFramework output", () => {
    expect(ghosttyBuildArgs("aarch64-apple-darwin", "/tmp/prefix")).toEqual([
      "build",
      "-Demit-lib-vt=true",
      "-Demit-xcframework=false",
      "-Dsimd=false",
      "-Doptimize=ReleaseFast",
      "-Dtarget=aarch64-macos",
      "-p",
      "/tmp/prefix",
    ]);
  });

  test("Linux archive builds use the matching Zig target", () => {
    expect(ghosttyBuildArgs("x86_64-unknown-linux-gnu", "/tmp/prefix")).toContain("-Dtarget=x86_64-linux-gnu");
  });

  test("source builds cannot discover an enclosing Wolfpack release tag", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "ghostty-vt-tagged-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
      execFileSync("git", ["config", "user.email", "wolfpack-test@example.invalid"], { cwd: repositoryRoot });
      execFileSync("git", ["config", "user.name", "Wolfpack Test"], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, "tracked"), "release\n");
      execFileSync("git", ["add", "tracked"], { cwd: repositoryRoot });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "release"], { cwd: repositoryRoot });
      execFileSync("git", ["tag", "v1.6.10"], { cwd: repositoryRoot });

      const sourceDir = join(repositoryRoot, ".cache", "ghostty-vt", "source");
      mkdirSync(sourceDir, { recursive: true });
      expect(execFileSync("git", ["describe", "--tags", "--exact-match"], {
        cwd: sourceDir,
        encoding: "utf8",
      }).trim()).toBe("v1.6.10");

      expect(() => runGhosttySourceBuild(
        "git",
        ["describe", "--tags", "--exact-match"],
        sourceDir,
        repositoryRoot,
      )).toThrow();
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("source preparation applies tracked Ghostty patches with zero fuzz", () => {
    expect(GHOSTTY_PATCHES.map(path => path.split("/").at(-1))).toEqual([
      "ghostty-vt-scroll-region.patch",
      "ghostty-vt-no-static-host-memset.patch",
      "ghostty-vt-no-libc-allocator-stubs.patch",
    ]);
    expect(ghosttyPatchArgs("/tmp/ghostty.patch")).toEqual(["-p1", "--fuzz=0", "-i", "/tmp/ghostty.patch"]);
  });

  test("source preparation is keyed by lock identity instead of ambiguous patch stamps", () => {
    expect(builderSource).toContain("source-${lock.revision}-${lockHash.slice(0, 16)}");
    expect(builderSource).toContain(".extracting-${process.pid}-${Date.now()}");
    expect(builderSource).toContain(".wolfpack-source-ready.json");
    expect(builderSource).not.toContain("source-${GHOSTTY_REVISION}.stamp");
    expect(builderSource).not.toContain(".wolfpack-patches");
  });

  test("source preparation never trusts a previously extracted cache tree", () => {
    expect(builderSource).not.toContain("if (existsSync(ready)) return sourceDir");
    expect(builderSource).toContain("rmSync(sourceDir, { recursive: true, force: true })");
  });

  test("stages header contents directly under include root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostty-vt-headers-"));
    try {
      const prefix = join(dir, "prefix");
      const targetOut = join(dir, "target");
      mkdirSync(join(prefix, "include", "ghostty"), { recursive: true });
      mkdirSync(join(targetOut, "include"), { recursive: true });
      writeFileSync(join(prefix, "include", "ghostty", "vt.h"), "/* vt */\n");

      copyGhosttyHeaders(prefix, targetOut);

      expect(existsSync(join(targetOut, "include", "ghostty", "vt.h"))).toBe(true);
      expect(existsSync(join(targetOut, "include", "include", "ghostty", "vt.h"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Ghostty lock is the single source of build pins and patch hashes", () => {
    const lock = readGhosttyLock();
    expect(lock.revision).toBe("a4aacd918ba9e79929ff608034c60a4341773ef0");
    expect(lock.sourceSha256).toBe("afac1d2dda1bea17f2aae0e1b8ce5dca78e7c3d008a947a15e8ce54f4bf4744c");
    expect(lock.zigVersion).toBe("0.16.0");
    expect(lock.patches).toEqual([
      {
        path: "patches/ghostty-vt-scroll-region.patch",
        sha256: "28afd678eb0fd5ecee1b8588eac9a6dc958cf8b944b9c5cd0564fb731febe3d9",
      },
      {
        path: "patches/ghostty-vt-no-static-host-memset.patch",
        sha256: "f2416747cc0be7539c989fd8839fdeab6155b7ab06a9852aa7d3080ddb8d79db",
      },
      {
        path: "patches/ghostty-vt-no-libc-allocator-stubs.patch",
        sha256: "acd9a24377e1af171ddb96469924cc0a45e91f8a156fb28eda338738180b1e82",
      },
    ]);
  });
});

describe("libghostty-vt bundle manifest provenance", () => {
  test("accepts a freshly generated bundle manifest", () => {
    withBundle((bundle) => {
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).not.toThrow();
    });
  });

  test("rejects a missing manifest", () => {
    withBundle((bundle) => {
      rmSync(join(bundle, "manifest.json"));
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).toThrow(/missing Ghostty bundle manifest/);
    });
  });

  test("rejects a corrupted archive", () => {
    withBundle((bundle) => {
      writeFileSync(join(bundle, "lib", "libghostty-vt.a"), "archive-v2");
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).toThrow(/archive sha256 mismatch/);
    });
  });

  test("rejects a corrupted header tree", () => {
    withBundle((bundle) => {
      writeFileSync(join(bundle, "include", "ghostty", "vt.h"), "/* header-v2 */\n");
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).toThrow(/header tree digest mismatch/);
    });
  });

  test("rejects a wrong target manifest", () => {
    withBundle((bundle) => {
      const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
      manifest.target = "x86_64-apple-darwin";
      writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).toThrow(/target mismatch/);
    });
  });

  test("detects Ghostty's static host memset override symbol", () => {
    expect(ghosttyArchiveHasHostMemsetOverride("00000000000fa0d0 t quirks_memset.memset\n")).toBe(true);
    expect(ghosttyArchiveHasHostMemsetOverride("                 U _memset\n00000000000000b4 T ___memset\n")).toBe(false);
  });

  test("detects libc allocator definitions that would shadow the host libc", () => {
    // Real new-pin regression: wuffs exported weak calloc/free stubs from the
    // static archive, and calloc returning NULL aborted every broker test.
    const nm = [
      "libghostty-vt-static_zcu.o:",
      "00000000000f7680 W calloc",
      "00000000000f7690 W free",
      "                 U malloc",
      "                 U _realloc",
      "0000000000001000 T ghostty_terminal_new",
      "0000000000001010 t free_list_push",
    ].join("\n");
    expect(ghosttyArchiveDefinedLibcAllocators(nm)).toEqual(["calloc", "free"]);
    expect(ghosttyArchiveDefinedLibcAllocators("00000000000000b4 T _malloc\n")).toEqual(["malloc"]);
    expect(ghosttyArchiveDefinedLibcAllocators("                 U calloc\n                 w free\n")).toEqual([]);
  });

  test("rejects a stale symbol-policy manifest", () => {
    withBundle((bundle) => {
      const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
      manifest.symbols.noHostMemsetOverride = false;
      writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).toThrow(/symbol policy is stale/);
    });
  });

  test("rejects a stale patch or lock manifest", () => {
    withBundle((bundle) => {
      const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
      manifest.lock.patches[0].sha256 = "00".repeat(32);
      writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => verifyBundleManifest("aarch64-apple-darwin", bundle)).toThrow(/lock content is stale/);
    });
  });
});
