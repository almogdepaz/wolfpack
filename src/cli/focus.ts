import { randomUUID } from "node:crypto";
import { isFocusOp, type FocusDocument, type FocusOp } from "../focus-contract.js";
import { candidateEnumerationCandidates } from "../tailnet-machine-contract.js";
import { call, issueJwt } from "./api.js";
import { CONFIG_PATH, loadConfig, parseConfig } from "./config.js";
import { isFocusHome, readFocusHomeConfig, writeFocusHome } from "../focus-home.js";
import { verifyMachineTarget, type VerifiedMachineTarget } from "./machine-target.js";
import { print, printError, printJson } from "./formatting.js";

export const FOCUS_USAGE = `Usage: wolfpack focus show|add|edit|done|undo|drop|reorder|nudge|note|day-summary [--json]
  add <title> [--id id] [--project /path] [--on machine] [--sessions id,id]
  edit <id> [title] [--project /path] [--on machine] [--sessions id,id]
  done|undo|drop <id>
  reorder <id> <id> ... (all intentions, in order)
  nudge|note <text>
  day-summary <YYYY-MM-DD> <done> <carried> <questions>
  home [<installation-id>|--clear]   show or set this machine's focus home (config.json; restart to apply)`;
export function parseFocusCommand(args: readonly string[]): { json: boolean; op?: FocusOp } {
  const json = args.includes("--json");
  const argv = args.filter(a => a !== "--json");
  const [cmd, ...rest] = argv;
  if (cmd === "show" && rest.length === 0) return { json };
  let op: unknown;
  if (cmd === "add" || cmd === "edit") {
    const fields: Record<string, unknown> = {};
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const value = rest[i]!;
      if (!value.startsWith("--")) { positional.push(value); continue; }
      const key = ({ "--id": "id", "--project": "project", "--on": "machine", "--sessions": "sessions" } as Record<string, string>)[value];
      const next = rest[++i];
      if (!key || !next || next.startsWith("--") || key in fields || (cmd === "edit" && key === "id")) throw new Error(FOCUS_USAGE);
      fields[key] = key === "sessions" ? next.split(",") : next;
    }
    if (cmd === "add" && positional.length === 1) op = { type: "add", intention: { id: randomUUID(), ...fields, title: positional[0] } };
    if (cmd === "edit" && positional.length >= 1 && positional.length <= 2) op = { type: "edit", id: positional[0], patch: { ...fields, ...(positional[1] !== undefined && { title: positional[1] }) } };
  } else if (["done", "undo", "drop"].includes(cmd ?? "") && rest.length === 1) op = { type: cmd, id: rest[0] };
  else if (cmd === "reorder") op = { type: cmd, ids: rest };
  else if ((cmd === "nudge" || cmd === "note") && rest.length === 1) op = { type: cmd, text: rest[0], ...(cmd === "nudge" && { author: "assistant" }) };
  else if (cmd === "day-summary" && rest.length === 4) op = { type: cmd, summary: { date: rest[0], done: Number(rest[1]), carried: Number(rest[2]), questions: Number(rest[3]) } };
  if (!isFocusOp(op)) throw new Error(FOCUS_USAGE);
  return { json, op };
}
type FocusRequest = (path: string, init?: RequestInit) => Promise<Response>;
interface FocusEnvelope { revision: number; local: boolean; home: string; document: FocusDocument }
async function checked<T = FocusEnvelope>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `focus HTTP ${response.status}`);
  return body as T;
}
export async function updateFocusWithRetry(op: FocusOp, request: FocusRequest): Promise<FocusDocument> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await checked(await request("/api/focus"));
    const response = await request("/api/focus", { method: "POST", body: JSON.stringify({ expectedRevision: current.revision, ops: [op] }) });
    if (response.status === 409 && attempt === 0) continue;
    return (await checked(response)).document;
  }
  throw new Error("focus revision conflict");
}
/** Discover, then verify identity using the same authenticated peer path as session control. */
export async function focusHomeTarget(target?: VerifiedMachineTarget): Promise<VerifiedMachineTarget | undefined> {
  const current = await checked(await call("/api/focus", {}, target));
  if (current.local) return target;
  const candidates = candidateEnumerationCandidates(await checked(await call("/api/tailnet/v1/candidates", {}, target)));
  const results = await Promise.all(candidates.filter(c => c.online).map(c => verifyMachineTarget(c.hostname, { tailscaleHostname: loadConfig()?.tailscaleHostname, jwt: issueJwt() })));
  const home = results.find(r => r.ok && r.target.machine.installationId === current.home);
  if (!home?.ok) throw new Error(`focus home ${current.home} offline; no local writes performed`);
  return home.target;
}
/** `home`: local config only; `home: null` clears it (this machine becomes its own home). */
export function parseFocusHomeCommand(args: readonly string[]): { json: boolean; home?: string | null } {
  const json = args.includes("--json");
  const rest = args.slice(1).filter(a => a !== "--json");
  if (rest.length === 0) return { json };
  if (rest.length === 1 && rest[0] === "--clear") return { json, home: null };
  // Same shape config.json accepts for focus.home.
  if (rest.length === 1 && !rest[0]!.startsWith("-") && isFocusHome(rest[0])) return { json, home: rest[0] };
  throw new Error("usage: wolfpack focus home [<installation-id>|--clear] [--json]");
}
interface FocusHomeIo { path: string; installationId(): string | Promise<string> }
const focusHomeIo: FocusHomeIo = { path: CONFIG_PATH, installationId: async () => (await import("../tailnet-machine-installation.js")).getInstallationId() };
/**
 * Sets or clears only `focus` in config.json: the raw object is rewritten
 * atomically so keys this build does not parse are kept.
 */
export async function focusHomeCommand(parsed: { json?: boolean; home?: string | null }, io: FocusHomeIo = focusHomeIo) {
  const raw = readFocusHomeConfig(io.path);
  const self = await io.installationId();
  const current = (raw && parseConfig(raw)?.focus?.home) ?? null;
  if (parsed.home !== undefined) {
    const { changed } = writeFocusHome(parsed.home, io.path);
    return { home: parsed.home ?? self, local: (parsed.home ?? self) === self, changed };
  }
  const home = current ?? self;
  return { home, local: home === self, changed: false };
}
export async function focusCommand(args: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  if (args.length === 0 || args.includes("--help")) { print(FOCUS_USAGE); return 0; }
  try {
    if (args[0] === "home") {
      const result = await focusHomeCommand(parseFocusHomeCommand(args));
      if (args.includes("--json")) printJson(result);
      else print(`focus home ${result.home}${result.local ? " (this machine)" : ""}${result.changed ? " · restart wolfpack on this machine to apply" : ""}`);
      return 0;
    }
    const parsed = parseFocusCommand(args);
    const home = await focusHomeTarget(target);
    const request: FocusRequest = (path, init) => call(path, init, home);
    const doc = parsed.op ? await updateFocusWithRetry(parsed.op, request) : (await checked(await request("/api/focus"))).document;
    if (parsed.json) printJson(doc);
    else if (!doc) print("Set your focus: wolfpack focus add <title>");
    else { print(`focus r${doc.revision}`); for (const i of doc.intentions) print(`${i.done ? "✓" : "○"} ${i.title} (${i.id})${i.doneAt ? ` · done ${i.doneAt}` : ""}`); if (doc.nudge) print(doc.nudge.text); }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) printJson({ error: message }); else printError(message);
    return 1;
  }
}
