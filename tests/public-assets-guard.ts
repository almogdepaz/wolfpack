import { existsSync } from "node:fs";

export function assertPublicAssetsPresent(path: string): void {
  if (!existsSync(path)) {
    throw new Error("src/public-assets.ts missing: run bun run scripts/gen-assets.ts");
  }
}
