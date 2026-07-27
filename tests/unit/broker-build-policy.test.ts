import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const buildRs = readFileSync(join(import.meta.dirname, "..", "..", "broker", "build.rs"), "utf8");

describe("broker build.rs Ghostty shim policy", () => {
  test("compiles the C shim through cc crate with Cargo host/target contract", () => {
    expect(buildRs).toContain("cc::Build::new()");
    expect(buildRs).toContain("env::var(\"TARGET\")");
    expect(buildRs).toContain("env::var(\"HOST\")");
    expect(buildRs).toContain(".target(&target)");
    expect(buildRs).toContain(".host(&host)");
    expect(buildRs).toContain(".compile(\"wolfpack_ghostty_vt_shim\")");
  });

  test("does not invoke ambient host cc/ar by hand", () => {
    expect(buildRs).not.toContain("std::process::Command");
    expect(buildRs).not.toContain("Command::new");
    expect(buildRs).not.toContain("env::var(\"CC\")");
    expect(buildRs).not.toContain("env::var(\"AR\")");
    expect(buildRs).not.toContain("unwrap_or_else(|_| \"cc\"");
    expect(buildRs).not.toContain("unwrap_or_else(|_| \"ar\"");
  });

  test("does not accept split include/lib override paths", () => {
    expect(buildRs).toContain("WOLFPACK_GHOSTTY_VT_DIR");
    expect(buildRs).not.toContain("WOLFPACK_GHOSTTY_VT_LIB_DIR");
    expect(buildRs).not.toContain("WOLFPACK_GHOSTTY_VT_INCLUDE_DIR");
  });

  test("verifies manifest, target, lock, archive, and header tree before linking", () => {
    expect(buildRs).toContain("verify_bundle(&target, &bundle_dir, &lock_path)");
    expect(buildRs).toContain("bundle_dir.join(\"manifest.json\")");
    expect(buildRs).toContain("manifest.target != target");
    expect(buildRs).toContain("manifest.lock_sha256 != lock_sha");
    expect(buildRs).toContain("manifest.lock != lock_json");
    expect(buildRs).toContain("sha256_file(&archive) != manifest.archive.sha256");
    expect(buildRs).toContain("digest_directory(&include_dir) != manifest.headers.digest");
    expect(buildRs).toContain("!manifest.symbols.no_host_memset_override");
    expect(buildRs).toContain("file_contains_bytes(&archive, b\"quirks_memset\")");
  });

  test("links the shim before the verified archive-only Ghostty search path", () => {
    const shimCompile = buildRs.indexOf(".compile(\"wolfpack_ghostty_vt_shim\")");
    const ghosttySearch = buildRs.indexOf("cargo:rustc-link-search=native={}", shimCompile);
    const ghosttyArchive = buildRs.indexOf("cargo:rustc-link-lib=static=ghostty-vt", ghosttySearch);
    expect(shimCompile).toBeGreaterThan(-1);
    expect(ghosttySearch).toBeGreaterThan(shimCompile);
    expect(ghosttyArchive).toBeGreaterThan(ghosttySearch);
    expect(buildRs).not.toContain("cargo:rustc-link-lib=dylib=ghostty-vt");
  });
});
