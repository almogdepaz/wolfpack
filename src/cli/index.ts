#!/usr/bin/env bun
/**
 * CLI dispatch entry point.
 */
import { printQR } from "../qr.js";
import { print, bold, dim, red, yellow, green, WOLF } from "./formatting.js";
import {
  loadConfig,
  isPortInUse,
  remoteUrl,
  type Config,
} from "./config.js";
import {
  serviceInstall,
  serviceUninstall,
  serviceStop,
  serviceStart,
  serviceRestart,
  serviceStatus,
  isServiceInstalled,
  isServiceRunning,
  updateStableBinary,
  uninstall,
} from "./service.js";
import { setup } from "./setup.js";
import { doctor } from "./doctor.js";
import { lsSessions, killSession } from "./sessions.js";
import { attachCommand } from "./attach.js";
import { runSessionCommand } from "./session-control.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migratePlanFormat, detectOldPlanFormat } from "../wolfpack-context.js";

export {
  loadConfig,
  saveConfig,
  isPortInUse,
  killPortHolder,
  type Config,
} from "./config.js";
export { generatePlist, generateSystemdUnit } from "./service.js";

export function planServiceEnsureAction(
  running: boolean,
  installed: boolean,
): "noop" | "start" | "install" {
  if (running) return "noop";
  return installed ? "start" : "install";
}

export function planBinaryUpdateAction(
  binaryUpdated: boolean,
  running: boolean,
  installed: boolean,
): "server-restart" | "noop" | "start" | "install" {
  if (binaryUpdated && running) return "server-restart";
  return planServiceEnsureAction(running, installed);
}

export function hasUninstallConfirmationFlag(argv: string[]): boolean {
  return argv.includes("--yes") || argv.includes("--force");
}

export type ServiceCommandAction = "install" | "uninstall" | "stop" | "start" | "restart" | "status";

export interface ParsedServiceCommand {
  readonly action: ServiceCommandAction;
  readonly broker: boolean;
}

export function parseServiceCommand(argv: readonly string[]): ParsedServiceCommand | null {
  const [action, ...flags] = argv;
  if (!action) return null;
  if (!["install", "uninstall", "stop", "start", "restart", "status"].includes(action)) return null;
  if (flags.some(flag => flag !== "--broker")) return null;
  return { action: action as ServiceCommandAction, broker: flags.includes("--broker") };
}

async function start() {
  const serviceMode = process.env.WOLFPACK_SERVICE === "1";
  const config = loadConfig();
  if (!config) {
    if (serviceMode) {
      throw new Error("missing or invalid config. Run 'wolfpack setup' to recreate ~/.wolfpack/config.json.");
    }
    print("  No valid config found. Running setup first...\n");
    await setup();
    process.exit(0);
  }

  // Service daemon mode — just start the server
  if (serviceMode) {
    process.env.WOLFPACK_DEV_DIR = config.devDir;
    process.env.WOLFPACK_PORT = String(config.port);
    await import("../server/index.js");
    return;
  }

  // CLI invocation — ensure service is running the current version
  const url = remoteUrl(config);
  const binaryUpdated = updateStableBinary();
  const wasRunning = isServiceRunning();
  try {
    const action = planBinaryUpdateAction(binaryUpdated, wasRunning, isServiceInstalled());
    if (action === "server-restart") {
      print(dim("  Updated server binary; restarting server only so broker sessions stay attached to the broker."));
      serviceRestart({ broker: false, skipBrokerSessionWarning: true });
    } else if (action === "start") serviceStart();
    else if (action === "install") serviceInstall();
  } catch (e) {
    print(red(`  Service startup failed: ${e}`));
    print(dim("  Run 'wolfpack service install' to retry."));
  }
  if (wasRunning && !isServiceRunning()) {
    print(yellow("  Service was running but didn't restart."));
    print(yellow(`  Run ${bold("wolfpack service start")} to restart it.`));
  } else if (!isServiceRunning()) {
    print(yellow("  Wolfpack service is not running."));
    print(yellow(`  Run ${bold("wolfpack service start")} or ${bold("wolfpack service install")} to launch it.`));
  }

  print(dim(WOLF));
  print(bold("  WOLFPACK"));
  print("");
  print(`  Local:    ${dim(`http://localhost:${config.port}/`)}`);
  if (url) print(`  Remote:   ${dim(url)}`);
  print("");
  print(dim("  Scan to open on your phone:"));
  print("");
  printQR(url ?? `http://localhost:${config.port}/`);
  print("");
}

function migratePlan(file?: string) {
  if (!file) {
    print(red("  Usage: wolfpack migrate-plan <file>"));
    print(dim("  Example: wolfpack migrate-plan PLAN.md"));
    process.exit(1);
  }

  const filePath = resolve(file);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    print(red(`  File not found: ${filePath}`));
    process.exit(1);
  }

  if (!detectOldPlanFormat(content)) {
    print(dim("  Plan does not appear to use old format. Nothing to migrate."));
    return;
  }

  const { content: migrated, count } = migratePlanFormat(content);
  writeFileSync(filePath, migrated);
  print(green(`  Migrated ${count} task header${count === 1 ? "" : "s"} to ## N. Title format.`));
  print(dim(`  File: ${filePath}`));
}

const cmd = process.argv[2];
const subcmd = process.argv[3];

async function main() {
  if (cmd === "setup") {
    await setup();
  } else if (cmd === "service") {
    const serviceCommand = parseServiceCommand(process.argv.slice(3));
    if (!serviceCommand) {
      print("  Usage: wolfpack service [install|uninstall|start|stop|restart|status] [--broker]");
      process.exit(1);
    }
    if (serviceCommand.action === "install") serviceInstall();
    else if (serviceCommand.action === "uninstall") serviceUninstall();
    else if (serviceCommand.action === "stop") serviceStop(serviceCommand.broker ? { broker: true } : {});
    else if (serviceCommand.action === "start") serviceStart();
    else if (serviceCommand.action === "restart") serviceRestart(serviceCommand.broker ? { broker: true } : {});
    else if (serviceCommand.action === "status") serviceStatus();
  } else if (cmd === "doctor") {
    process.exit(await doctor());
  } else if (cmd === "ls" || cmd === "list") {
    process.exit(await lsSessions());
  } else if (cmd === "session") {
    process.exit(await runSessionCommand(process.argv.slice(3)));
  } else if (cmd === "kill") {
    process.exit(await killSession(subcmd));
  } else if (cmd === "attach") {
    process.exit(await attachCommand(process.argv.slice(3)));
  } else if (cmd === "uninstall") {
    if (!hasUninstallConfirmationFlag(process.argv.slice(3))) {
      print(red("  Refusing to uninstall without confirmation."));
      print(dim("  This will recursively delete ~/.wolfpack/ (keys, secrets, config)."));
      print(dim("  Re-run with: wolfpack uninstall --yes"));
      process.exit(1);
    }
    uninstall();
  } else if (cmd === "migrate-plan") {
    migratePlan(subcmd);
  } else if (cmd === "worker") {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("../ralph-macchio.js");
  } else {
    await start();
  }
}

// only run when executed directly, not when imported for tests
if (import.meta.main) {
  main().catch((e) => {
    print(red(`  Fatal error: ${e.message || e}`));
    process.exit(1);
  });
}
