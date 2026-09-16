import { readFileSync } from "node:fs";
import { call } from "./api.ts";
import type { VerifiedMachineTarget } from "./machine-target.ts";
import { print, printApiJson, printError } from "./formatting.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function parseTarget(value: string | undefined): { extensionId: string; documentId: string } | null { const [extensionId, documentId, extra] = (value ?? "").split("/"); return extensionId && documentId && !extra && /^[a-z][a-z0-9-]{0,63}$/.test(extensionId) && /^[a-z][a-z0-9-]{0,63}$/.test(documentId) ? { extensionId, documentId } : null; }
function args(argv: readonly string[]): Record<string, string | true> | null { const out: Record<string, string | true> = {}; for (let i = 0; i < argv.length; i++) { const key = argv[i]!; if (!key.startsWith("--") || Object.hasOwn(out, key)) return null; if (key === "--json") out[key] = true; else { const value = argv[++i]; if (!value || value.startsWith("--")) return null; out[key] = value; } } return out; }
export function extensionDataUsage(): string { return "Usage: wolfpack extension-data read <extension-id/document-id> --session <exact-uuid> [--json]\n       wolfpack extension-data publish <extension-id/document-id> --session <exact-uuid> --file <json-file> --if-revision <n> --request-id <uuid> [--json]"; }
export async function extensionDataCommand(argv: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  const action = argv[0]; const name = parseTarget(argv[1]); const flags = args(argv.slice(2));
  const readFlagsValid = action === "read" && Object.keys(flags ?? {}).every((key) => key === "--session" || key === "--json");
  const publishFlagsValid = action === "publish" && typeof flags?.["--file"] === "string" && typeof flags?.["--if-revision"] === "string" && typeof flags?.["--request-id"] === "string" && UUID.test(flags["--request-id"] as string) && /^(0|[1-9][0-9]*)$/.test(flags["--if-revision"] as string) && Object.keys(flags).every((key) => ["--session", "--file", "--if-revision", "--request-id", "--json"].includes(key));
  if (!name || !flags || (action !== "read" && action !== "publish") || typeof flags["--session"] !== "string" || !UUID.test(flags["--session"] as string) || !readFlagsValid && !publishFlagsValid) { printError(extensionDataUsage()); return 2; }
  const path = `/api/extensions/documents/${name.extensionId}/${name.documentId}`;
  let response: Response;
  try { response = action === "read" ? await call(`${path}?session=${encodeURIComponent(flags["--session"] as string)}`, {}, target) : await call(path, { method: "POST", body: JSON.stringify({ sessionId: flags["--session"], document: JSON.parse(readFileSync(flags["--file"] as string, "utf8")), ifRevision: Number(flags["--if-revision"]), requestId: flags["--request-id"], schemaVersion: 1 }) }, target); } catch (error) { printError(`extension-data request failed: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  const value: unknown = await response.json().catch(() => ({ error: { code: "INVALID_RESPONSE", message: "server returned invalid JSON" } }));
  if (!response.ok) { if (flags["--json"]) printApiJson({ ok: false, ...((value && typeof value === "object") ? value : {}) }, target); else printError(JSON.stringify(value)); return response.status === 401 ? 5 : 1; }
  if (flags["--json"]) printApiJson(value, target); else print(JSON.stringify(value, null, 2)); return 0;
}
