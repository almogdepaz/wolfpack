import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WOLFPACK_DIR } from "./config.js";
import { print, printError, printJson, red } from "./formatting.js";

export { LOG_RETENTION, LOG_ROTATE_BYTES, rotateLogFile } from "../log-rotation.js";

export interface ParsedLogsOptions { readonly follow: boolean; readonly json: boolean; readonly broker: boolean }
export function parseLogsOptions(argv: readonly string[]): ParsedLogsOptions | null {
  if (argv.some(arg => !["--follow", "--json", "--broker"].includes(arg))) return null;
  return { follow: argv.includes("--follow"), json: argv.includes("--json"), broker: argv.includes("--broker") };
}

export function normalizeLogLine(line: string): unknown {
  try { return JSON.parse(line); } catch { return { raw: line }; }
}

export async function logsCommand(argv: readonly string[]): Promise<number> {
  const options = parseLogsOptions(argv);
  if (!options) {
    printError(red("Usage: wolfpack logs [--follow] [--json] [--broker]"));
    return 2;
  }
  const path = join(WOLFPACK_DIR, options.broker ? "broker.log" : "wolfpack.log");
  if (!existsSync(path)) {
    if (options.json) printJson({ ok: false, error: { code: "LOG_NOT_FOUND", path } });
    else printError(red(`Log file does not exist: ${path}`));
    return 1;
  }
  if (options.follow) {
    const child = Bun.spawn(["tail", "-n", "200", "-F", path], { stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) print(options.json ? JSON.stringify(normalizeLogLine(line)) : line);
    }
    return await child.exited;
  }
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-200);
  if (options.json) printJson({ ok: true, path, entries: lines.map(normalizeLogLine) });
  else for (const line of lines) print(line);
  return 0;
}
