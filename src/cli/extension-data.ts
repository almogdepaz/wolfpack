import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readBoundedRegularFile } from "../extensions/bounded-file.ts";
import { call } from "./api.ts";
import type { VerifiedMachineTarget } from "./machine-target.ts";
import { print, printApiJson, printError } from "./formatting.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function parseTarget(value: string | undefined): { extensionId: string; documentId: string } | null { const [extensionId, documentId, extra] = (value ?? "").split("/"); return extensionId && documentId && !extra && /^[a-z][a-z0-9-]{0,63}$/.test(extensionId) && /^[a-z][a-z0-9-]{0,63}$/.test(documentId) ? { extensionId, documentId } : null; }
function args(argv: readonly string[]): Record<string, string | true> | null { const out: Record<string, string | true> = {}; for (let i = 0; i < argv.length; i++) { const key = argv[i]!; if (!key.startsWith("--") || Object.hasOwn(out, key)) return null; if (key === "--json") out[key] = true; else { const value = argv[++i]; if (!value || value.startsWith("--")) return null; out[key] = value; } } return out; }
export function extensionDataUsage(): string { return "Usage: wolfpack extension-data read <extension-id/document-id> --session <exact-uuid> [--json]\n       wolfpack extension-data publish <extension-id/document-id> --session <exact-uuid> --file <json-file> --if-revision <n> --request-id <uuid> [--json]\n       wolfpack extension-data put-blob <extension-id> --session <exact-uuid> --file <path> [--json]\n       wolfpack extension-data delete-blob <extension-id> --digest <sha256> --session <exact-uuid> [--json]"; }
async function blobCommand(argv: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  const action = argv[0], extensionId = argv[1], flags = args(argv.slice(2));
  const allowed = action === "put-blob" ? ["--session", "--file", "--json"] : ["--session", "--digest", "--json"];
  if (!extensionId || !/^[a-z][a-z0-9-]{0,63}$/.test(extensionId) || !flags || typeof flags["--session"] !== "string" || !UUID.test(flags["--session"] as string) || Object.keys(flags).some(key => !allowed.includes(key)) || (action === "put-blob" ? typeof flags["--file"] !== "string" : typeof flags["--digest"] !== "string" || !/^[a-f0-9]{64}$/.test(flags["--digest"] as string))) { printError(extensionDataUsage()); return 2; }
  try {
    let digest = flags["--digest"] as string, bytes: Buffer<ArrayBuffer> | undefined;
    if (action === "put-blob") {
      const catalog = await call("/api/extensions", {}, target); const value = await catalog.json() as any;
      const item = value?.installations?.find((item: any) => item.extensionId === extensionId);
      const limit = item?.blobs?.maxBlobBytes;
      if (!catalog.ok || value.safeMode || !item?.enabled || !Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) throw new Error("installed blob declaration is unavailable");
      const file = realpathSync(flags["--file"] as string);
      if (statSync(file).size > limit) throw new Error("blob file exceeds declared limit");
      bytes = readBoundedRegularFile(file, limit); digest = createHash("sha256").update(bytes).digest("hex");
    }
    const response = await call(`/api/extensions/blobs/${extensionId}/${digest}?session=${flags["--session"]}`, { method: action === "put-blob" ? "PUT" : "DELETE", ...(bytes ? { headers: { "Content-Type": "application/octet-stream" }, body: bytes } : {}) }, target);
    const value = await response.json().catch(() => ({ error: { code: "INVALID_RESPONSE", message: "server returned invalid JSON" } }));
    if (!response.ok) { if (flags["--json"]) printApiJson({ ok: false, ...value }, target); else printError(JSON.stringify(value)); return response.status === 401 ? 5 : 1; }
    const result = action === "put-blob" ? { digest: value.digest, bytes: value.bytes, created: value.created } : value;
    if (flags["--json"]) printApiJson(result, target); else print(JSON.stringify(result, null, 2)); return 0;
  } catch (error) { printError(`extension-data request failed: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
export async function extensionDataCommand(argv: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  if (argv[0] === "put-blob" || argv[0] === "delete-blob") return blobCommand(argv, target);
  const action = argv[0]; const name = parseTarget(argv[1]); const flags = args(argv.slice(2));
  const readFlagsValid = action === "read" && Object.keys(flags ?? {}).every((key) => key === "--session" || key === "--json");
  const publishFlagsValid = action === "publish" && typeof flags?.["--file"] === "string" && typeof flags?.["--if-revision"] === "string" && typeof flags?.["--request-id"] === "string" && UUID.test(flags["--request-id"] as string) && /^(0|[1-9][0-9]*)$/.test(flags["--if-revision"] as string) && Object.keys(flags).every((key) => ["--session", "--file", "--if-revision", "--request-id", "--json"].includes(key));
  if (!name || !flags || (action !== "read" && action !== "publish") || typeof flags["--session"] !== "string" || !UUID.test(flags["--session"] as string) || !readFlagsValid && !publishFlagsValid) { printError(extensionDataUsage()); return 2; }
  const path = `/api/extensions/documents/${name.extensionId}/${name.documentId}`;
  let response: Response;
  try {
    if (action === "read") response = await call(`${path}?session=${encodeURIComponent(flags["--session"] as string)}`, {}, target);
    else {
      const catalog = await call("/api/extensions", {}, target);
      const value: unknown = await catalog.json();
      const installation = value && typeof value === "object" && Array.isArray((value as any).installations) ? (value as any).installations.find((item: any) => item.extensionId === name.extensionId) : undefined;
      const declaration = installation?.documents?.find((item: any) => item.id === name.documentId);
      if (!catalog.ok || !declaration || !Number.isSafeInteger(declaration.schemaVersion)) throw new Error("installed document declaration is unavailable");
      response = await call(path, { method: "POST", body: JSON.stringify({ sessionId: flags["--session"], document: JSON.parse(readFileSync(flags["--file"] as string, "utf8")), ifRevision: Number(flags["--if-revision"]), requestId: flags["--request-id"], schemaVersion: declaration.schemaVersion }) }, target);
    }
  } catch (error) { printError(`extension-data request failed: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  const value: unknown = await response.json().catch(() => ({ error: { code: "INVALID_RESPONSE", message: "server returned invalid JSON" } }));
  if (!response.ok) { if (flags["--json"]) printApiJson({ ok: false, ...((value && typeof value === "object") ? value : {}) }, target); else printError(JSON.stringify(value)); return response.status === 401 ? 5 : 1; }
  if (flags["--json"]) printApiJson(value, target); else print(JSON.stringify(value, null, 2)); return 0;
}
