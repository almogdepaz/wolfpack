#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["zigVersion"])' "${repo_root}/ghostty-vt.lock.json")"
os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Darwin-arm64)
    slug="aarch64-macos"
    sha="b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489"
    ;;
  Linux-x86_64)
    slug="x86_64-linux"
    sha="70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00"
    ;;
  *)
    echo "unsupported host for pinned Zig ${version}: ${os}-${arch}" >&2
    exit 2
    ;;
esac

private_parent="${RUNNER_TEMP:-/tmp}"
private_dir="$(mktemp -d "${private_parent%/}/wolfpack-zig-${version}.XXXXXX")"
chmod 700 "${private_dir}"
archive_root="zig-${slug}-${version}"
archive="${private_dir}/${archive_root}.tar.xz"
install_dir="${private_dir}/${archive_root}"
keep_private_dir=false
cleanup_private_dir() {
  if [[ "${keep_private_dir}" != true ]]; then
    rm -rf "${private_dir}"
  fi
}
trap cleanup_private_dir EXIT

verify_archive() {
  local observed
  observed="$(shasum -a 256 "${archive}" | awk '{print $1}')"
  if [[ "${observed}" != "${sha}" ]]; then
    echo "zig sha256 mismatch: expected ${sha}, got ${observed}" >&2
    return 1
  fi
}

curl -fL --retry 3 -o "${archive}" "https://ziglang.org/download/${version}/${archive_root}.tar.xz"
verify_archive
tar -xJf "${archive}" -C "${private_dir}"
if [[ ! -x "${install_dir}/zig" ]]; then
  echo "authenticated Zig archive did not contain executable ${archive_root}/zig" >&2
  exit 1
fi
"${install_dir}/zig" version
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${install_dir}" >> "${GITHUB_PATH}"
else
  echo "add to PATH: ${install_dir}"
fi
keep_private_dir=true
