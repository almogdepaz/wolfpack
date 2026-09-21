import { accessSync, constants, realpathSync, statSync } from "node:fs";

/** Resolves a target-host extension only when it is a readable regular file. */
export function canonicalReadableRegularFile(path: string): string | undefined {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isFile()) return undefined;
    accessSync(canonical, constants.R_OK);
    return canonical;
  } catch {
    return undefined;
  }
}
