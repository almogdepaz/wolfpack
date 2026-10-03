export const PORTABLE_PACKAGE_PATH_LIMITS = { maxLength: 256, maxDepth: 8, maxComponentLength: 128 } as const;

/** Deliberately portable ASCII subset; no normalization aliases or device names. */
export function assertPortablePackagePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > PORTABLE_PACKAGE_PATH_LIMITS.maxLength) {
    throw new Error("package path must be a bounded nonempty relative path");
  }
  const parts = value.split("/");
  if (parts.length > PORTABLE_PACKAGE_PATH_LIMITS.maxDepth) throw new Error("package path exceeds depth limit");
  for (const part of parts) {
    if (
      !/^[A-Za-z0-9._@+-]+$/.test(part) || part.length > PORTABLE_PACKAGE_PATH_LIMITS.maxComponentLength ||
      part === "." || part === ".." || part.endsWith(".") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ) throw new Error("package path has an invalid or nonportable component");
  }
}

/** Checks both leaf collisions and case aliases in implicit parent directories. */
export function portableFileInventory(paths: readonly string[]): ReadonlySet<string> {
  const files = new Set<string>();
  const directories = new Map<string, string>();
  for (const path of paths) {
    assertPortablePackagePath(path);
    const key = path.toLowerCase();
    if (files.has(key) || directories.has(key)) throw new Error("duplicate or file/directory package path collision");
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const parent = parts.slice(0, length).join("/");
      const parentKey = parent.toLowerCase();
      if (files.has(parentKey) || (directories.has(parentKey) && directories.get(parentKey) !== parent)) {
        throw new Error("case alias or file/directory package path collision");
      }
      directories.set(parentKey, parent);
    }
    files.add(key);
  }
  return new Set(directories.values());
}
