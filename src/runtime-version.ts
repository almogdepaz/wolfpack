/** Release builds pin this tested runtime. Older Bun 1.3.9 reproduced a native
 * worker-termination crash; do not silently run relay ownership on that runtime. */
export const MINIMUM_BUN_VERSION = "1.4.2";
export function assertSupportedBunRuntime(version: string | undefined = typeof Bun === "undefined" ? undefined : Bun.version): void {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (parts && (Number(parts[1]) > 1 || Number(parts[1]) === 1 && (Number(parts[2]) > 4 || Number(parts[2]) === 4 && Number(parts[3]) >= 2))) return;
  throw new Error(`Wolfpack requires stable Bun ${MINIMUM_BUN_VERSION} or newer; found ${version ?? "no Bun runtime"}. Use a current packaged binary or update the source runtime before starting the relay.`);
}
