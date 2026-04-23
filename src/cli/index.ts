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
  serviceStatus,
  isServiceInstalled,
  isServiceRunning,
  updateStableBinary,
  uninstall,
} from "./service.js";
import { setup } from "./setup.js";
import { doctor } from "./doctor.js";
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
    if (binaryUpdated && wasRunning) {
      // new binary on disk but old version still in memory — reinstall
      serviceInstall();
    } else {
      const action = planServiceEnsureAction(wasRunning, isServiceInstalled());
      if (action === "start") serviceStart();
      else if (action === "install") serviceInstall();
    }
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
    if (subcmd === "install") serviceInstall();
    else if (subcmd === "uninstall") serviceUninstall();
    else if (subcmd === "stop") serviceStop();
    else if (subcmd === "start") serviceStart();
    else if (subcmd === "status") serviceStatus();
    else {
      print("  Usage: wolfpack service [install|uninstall|start|stop|status]");
      process.exit(1);
    }
  } else if (cmd === "doctor") {
    process.exit(await doctor());
  } else if (cmd === "uninstall") {
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
