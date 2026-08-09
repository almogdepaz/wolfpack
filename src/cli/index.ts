#!/usr/bin/env bun
/**
 * CLI dispatch entry point.
 */
import { printQR } from "../qr.js";
import { print, printError, bold, dim, red, yellow, WOLF } from "./formatting.js";
import pkg from "../../package.json";
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
import { doctor } from "./doctor.js";
import { lsSessions, killSession } from "./sessions.js";
import { attachCommand } from "./attach.js";
import { runAgentCommand, runSessionCommand } from "./session-control.js";
import { applyServiceAuthFile } from "./service-auth.js";

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

const HELP_ALIASES = new Set(["--help", "-h", "help"]);

export function topLevelUsage(): string {
  return `Usage: wolfpack [command]

Commands:
  wolfpack                         Start the dashboard/server
  wolfpack setup                   Run the setup wizard
  wolfpack service <action>        Manage the Wolfpack service
  wolfpack doctor                  Diagnose the installation
  wolfpack list [--json]           List active sessions (alias: ls)
  wolfpack session create <project> Create a top-level session
  wolfpack session <action>        Inspect or control sessions
  wolfpack agent spawn <project>   Spawn a same-harness child agent
  wolfpack kill <session-or-id> [--json] Kill a session
  wolfpack attach [session]        Attach this terminal to a session
  wolfpack uninstall --yes         Remove Wolfpack configuration and services
  wolfpack --version               Print the installed version

Help:
  wolfpack --help
  wolfpack setup --help
  wolfpack session --help
  wolfpack agent --help`;
}

export function setupUsage(): string {
  return `Usage: wolfpack setup

Run the interactive first-run setup wizard.`;
}

async function runSetup(): Promise<void> {
  const { setup } = await import("./setup.js");
  await setup();
}

export function shouldStartDashboard(argv: readonly string[]): boolean {
  return argv.length === 0;
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
  const serviceAuthFile = process.env.WOLFPACK_SERVICE_AUTH_FILE;
  if (serviceMode && serviceAuthFile) applyServiceAuthFile(serviceAuthFile);

  const config = loadConfig();
  if (!config) {
    if (serviceMode) {
      throw new Error("missing or invalid config. Run 'wolfpack setup' to recreate ~/.wolfpack/config.json.");
    }
    print("  No valid config found. Running setup first...\n");
    await runSetup();
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
    printError(red(`  Service startup failed: ${e}`));
    printError(dim("  Run 'wolfpack service install' to retry."));
  }
  if (wasRunning && !isServiceRunning()) {
    printError(yellow("  Service was running but didn't restart."));
    printError(yellow(`  Run ${bold("wolfpack service start")} to restart it.`));
  } else if (!isServiceRunning()) {
    printError(yellow("  Wolfpack service is not running."));
    printError(yellow(`  Run ${bold("wolfpack service start")} or ${bold("wolfpack service install")} to launch it.`));
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

async function main() {
  const argv = process.argv.slice(2);
  const [cmd] = argv;

  if (argv.length === 1 && HELP_ALIASES.has(cmd)) {
    print(topLevelUsage());
  } else if (argv.length === 1 && (cmd === "--version" || cmd === "-V")) {
    print(pkg.version);
  } else if (shouldStartDashboard(argv)) {
    await start();
  } else if (cmd === "setup" && argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) {
    print(setupUsage());
  } else if (cmd === "setup") {
    await runSetup();
  } else if (cmd === "service") {
    const serviceCommand = parseServiceCommand(argv.slice(1));
    if (!serviceCommand) {
      printError("  Usage: wolfpack service [install|uninstall|start|stop|restart|status] [--broker]");
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
    process.exit(await lsSessions(argv.slice(1)));
  } else if (cmd === "session") {
    process.exit(await runSessionCommand(argv.slice(1)));
  } else if (cmd === "agent") {
    process.exit(await runAgentCommand(argv.slice(1)));
  } else if (cmd === "kill") {
    process.exit(await killSession(argv.slice(1)));
  } else if (cmd === "attach") {
    process.exit(await attachCommand(argv.slice(1)));
  } else if (cmd === "uninstall") {
    if (!hasUninstallConfirmationFlag(argv.slice(1))) {
      printError(red("  Refusing to uninstall without confirmation."));
      printError(dim("  This will recursively delete ~/.wolfpack/ (keys, secrets, config)."));
      printError(dim("  Re-run with: wolfpack uninstall --yes"));
      process.exit(1);
    }
    uninstall();
  } else {
    printError(red(`  Unknown command: ${cmd}`));
    printError(dim("  Run 'wolfpack --help' for available commands."));
    process.exit(1);
  }
}

// only run when executed directly, not when imported for tests
if (import.meta.main) {
  main().catch((e) => {
    printError(red(`  Fatal error: ${e.message || e}`));
    process.exit(1);
  });
}
