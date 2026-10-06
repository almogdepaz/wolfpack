import { parse } from "semver";

/** Standard SemVer, without v/= prefixes, whitespace or normalization aliases. */
export function isCanonicalPackageVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  const version = parse(value);
  if (!version) return false;
  // semver.valid() deliberately drops build metadata. Reconstruct it rather
  // than rejecting legal exact versions such as 1.2.3+build.001.
  const prerelease = version.prerelease.length ? `-${version.prerelease.join(".")}` : "";
  const build = version.build.length ? `+${version.build.join(".")}` : "";
  return `${version.major}.${version.minor}.${version.patch}${prerelease}${build}` === value;
}
