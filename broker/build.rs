use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    schema_version: u8,
    target: String,
    lock_sha256: String,
    lock: serde_json::Value,
    archive: ManifestPathAndHash,
    headers: ManifestPathAndDigest,
    symbols: ManifestSymbols,
}

#[derive(Debug, Deserialize)]
struct ManifestPathAndHash {
    path: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct ManifestPathAndDigest {
    path: String,
    digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSymbols {
    no_host_memset_override: bool,
}

fn main() {
    println!("cargo:rerun-if-env-changed=WOLFPACK_GHOSTTY_VT_DIR");
    println!("cargo:rerun-if-changed=native/ghostty_vt_shim.c");
    println!("cargo:rerun-if-changed=native/ghostty_vt_shim.h");

    let target = env::var("TARGET").expect("TARGET is set by Cargo");
    let host = env::var("HOST").expect("HOST is set by Cargo");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = manifest.parent().expect("broker has repository parent");
    let lock_path = root.join("ghostty-vt.lock.json");
    println!("cargo:rerun-if-changed={}", lock_path.display());

    let bundle_dir = env::var_os("WOLFPACK_GHOSTTY_VT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("native/ghostty-vt").join(&target));
    let manifest_path = bundle_dir.join("manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let verified = verify_bundle(&target, &bundle_dir, &lock_path);
    println!("cargo:rerun-if-changed={}", verified.archive.display());
    println!("cargo:rerun-if-changed={}", verified.include_dir.display());

    cc::Build::new()
        .file(manifest.join("native/ghostty_vt_shim.c"))
        .include(&verified.include_dir)
        .define("GHOSTTY_STATIC", None)
        .std("c11")
        .host(&host)
        .target(&target)
        .compile("wolfpack_ghostty_vt_shim");

    println!(
        "cargo:rustc-link-search=native={}",
        verified.lib_dir.display()
    );
    println!("cargo:rustc-link-lib=static=ghostty-vt");

    if target.contains("apple-darwin") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=CoreText");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=c++");
    } else if target.contains("linux") {
        println!("cargo:rustc-link-lib=stdc++");
        println!("cargo:rustc-link-lib=m");
        println!("cargo:rustc-link-lib=dl");
        println!("cargo:rustc-link-lib=pthread");
    }
}

struct VerifiedBundle {
    include_dir: PathBuf,
    lib_dir: PathBuf,
    archive: PathBuf,
}

fn verify_bundle(target: &str, bundle_dir: &Path, lock_path: &Path) -> VerifiedBundle {
    let manifest_path = bundle_dir.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).unwrap_or_else(|error| {
        panic!(
            "broker build requires a verified Ghostty bundle manifest at {}: {}. run `bun run scripts/build-ghostty-vt.ts --target {}` or set WOLFPACK_GHOSTTY_VT_DIR to a verified bundle root",
            manifest_path.display(),
            error,
            target,
        )
    });
    let manifest: BundleManifest =
        serde_json::from_slice(&manifest_bytes).unwrap_or_else(|error| {
            panic!(
                "invalid Ghostty bundle manifest {}: {}",
                manifest_path.display(),
                error
            )
        });
    if manifest.schema_version != 1 {
        panic!(
            "unsupported Ghostty bundle manifest schema {} at {}",
            manifest.schema_version,
            manifest_path.display()
        );
    }
    if manifest.target != target {
        panic!(
            "Ghostty bundle target mismatch at {}: expected {}, got {}",
            manifest_path.display(),
            target,
            manifest.target
        );
    }

    let lock_bytes = fs::read(lock_path).unwrap_or_else(|error| {
        panic!(
            "failed to read Ghostty lock {}: {}",
            lock_path.display(),
            error
        )
    });
    let lock_sha = sha256_bytes(&lock_bytes);
    if manifest.lock_sha256 != lock_sha {
        panic!(
            "Ghostty bundle lock sha256 mismatch at {}: expected {}, got {}",
            manifest_path.display(),
            lock_sha,
            manifest.lock_sha256
        );
    }
    let lock_json: serde_json::Value = serde_json::from_slice(&lock_bytes)
        .unwrap_or_else(|error| panic!("invalid Ghostty lock {}: {}", lock_path.display(), error));
    if manifest.lock != lock_json {
        panic!(
            "Ghostty bundle lock content is stale at {}",
            manifest_path.display()
        );
    }
    if !manifest.symbols.no_host_memset_override {
        panic!(
            "Ghostty bundle symbol policy is stale at {}",
            manifest_path.display()
        );
    }

    if manifest.archive.path != "lib/libghostty-vt.a" || manifest.headers.path != "include" {
        panic!(
            "Ghostty bundle manifest {} must use archive-only lib/libghostty-vt.a and include roots",
            manifest_path.display()
        );
    }
    let archive = bundle_dir.join(&manifest.archive.path);
    if sha256_file(&archive) != manifest.archive.sha256 {
        panic!(
            "Ghostty static archive sha256 mismatch for {}",
            archive.display()
        );
    }
    if file_contains_bytes(&archive, b"quirks_memset") {
        panic!(
            "Ghostty static archive contains forbidden host memset override symbol in {}",
            archive.display()
        );
    }
    let include_dir = bundle_dir.join(&manifest.headers.path);
    if digest_directory(&include_dir) != manifest.headers.digest {
        panic!(
            "Ghostty header tree digest mismatch for {}",
            include_dir.display()
        );
    }
    if !include_dir.join("ghostty/vt.h").exists() {
        panic!(
            "verified Ghostty bundle is missing ghostty/vt.h under {}",
            include_dir.display()
        );
    }

    VerifiedBundle {
        lib_dir: bundle_dir.join("lib"),
        include_dir,
        archive,
    }
}

fn sha256_file(path: &Path) -> String {
    let mut file = fs::File::open(path)
        .unwrap_or_else(|error| panic!("failed to open {}: {}", path.display(), error));
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buf)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hex(hasher.finalize().as_slice())
}

fn file_contains_bytes(path: &Path, needle: &[u8]) -> bool {
    let bytes = fs::read(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
    bytes.windows(needle.len()).any(|window| window == needle)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(hasher.finalize().as_slice())
}

fn digest_directory(root: &Path) -> String {
    let mut files = Vec::new();
    collect_files(root, root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (relative, path) in files {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(sha256_file(&path).as_bytes());
        hasher.update([0]);
    }
    hex(hasher.finalize().as_slice())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let entries = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("failed to read directory {}: {}", dir.display(), error));
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| panic!("failed to read directory entry: {error}"));
        let path = entry.path();
        let ty = entry
            .file_type()
            .unwrap_or_else(|error| panic!("failed to stat {}: {}", path.display(), error));
        if ty.is_dir() {
            collect_files(root, &path, out);
        } else if ty.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("file is under root")
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            out.push((relative, path));
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
