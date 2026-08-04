import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

function machineIdPath(taskRoot: string | undefined): string {
  if (process.env.WOLFPACK_MACHINE_ID_PATH) return process.env.WOLFPACK_MACHINE_ID_PATH;
  return taskRoot === undefined ? join(homedir(), ".wolfpack", "machine-id") : join(dirname(taskRoot), "machine-id");
}

/** Stable install identity; tests inject the task root instead of touching a user install. */
export function getMachineId(taskRoot: string | undefined = process.env.WOLFPACK_TASK_ROOT): string {
  const path = machineIdPath(taskRoot);
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
    throw new TypeError("persisted Wolfpack machine id is invalid");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = randomUUID();
  writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return value;
}
