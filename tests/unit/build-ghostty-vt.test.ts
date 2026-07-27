import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GHOSTTY_PATCHES,
  copyGhosttyHeaders,
  createBundleManifest,
  ghosttyArchiveHasHostMemsetOverride,
  ghosttyBuildArgs,
  ghosttyPatchArgs,
  readGhosttyLock,
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

  test("source preparation applies tracked Ghostty patches with zero fuzz", () => {
    expect(GHOSTTY_PATCHES.map(path => path.split("/").at(-1))).toEqual([
      "ghostty-vt-scroll-region.patch",
      "ghostty-vt-no-static-host-memset.patch",
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
    expect(lock.revision).toBe("7aa9591746ffa4d2eee458960c76554352832595");
    expect(lock.sourceSha256).toBe("468a0564bdd481e291f6150b94300f9ff37c1a7524f6ae76e99c4ec15535cf66");
    expect(lock.zigVersion).toBe("0.16.0");
    expect(lock.patches).toEqual([
      {
        path: "patches/ghostty-vt-scroll-region.patch",
        sha256: "742062e34969dced67badc6ad984d8b5f0745fc9ead02bf3fab7d76e197f8381",
      },
      {
        path: "patches/ghostty-vt-no-static-host-memset.patch",
        sha256: "795e3d9e0344e9a3770550f27c533394443f21eec808333fe266a6e4835de292",
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
