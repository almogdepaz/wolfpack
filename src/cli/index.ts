#!/usr/bin/env bun
/**
 * CLI dispatch entry point.
 */
import { printQR } from "../qr.js";
import { print, printError, printJson, bold, dim, red, yellow, WOLF } from "./formatting.js";
import pkg from "../../package.json";
import {
  loadConfig,
  remoteUrl,
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
import { logsCommand } from "./logs.js";
import { issueJwt } from "./api.js";
import {
  extractMachineSelector,
  verifyMachineTarget,
} from "./machine-target.js";
import type {
  MachineTargetFailure,
  VerifiedMachineTarget,
} from "./machine-target.js";

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
const SERVICE_USAGE = `Usage: wolfpack service [install|uninstall|start|stop|restart|status] [--broker]
       wolfpack service restart --server-only`;

export function topLevelUsage(): string {
  return `Usage: wolfpack [--machine <short-name-or-fqdn>] [command]

Global selector:
  --machine <short-name-or-fqdn>    Target a verified peer for supported session control commands

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
  wolfpack logs [--follow|--json]  Read or follow service logs
  wolfpack uninstall --yes         Remove Wolfpack configuration and services
  wolfpack --version               Print the installed version

Help:
  wolfpack --help
  wolfpack setup --help
  wolfpack session --help
  wolfpack agent --help`;
}

export function setupUsage(): string {
  return `Usage: wolfpack setup [--non-interactive] [--defer-service-restart] [--dev-dir <path>] [--port <1024-65535>]

Run the first-run setup wizard. Unattended setup must be explicitly enabled;
unspecified fields preserve an existing valid configuration. Service-restart deferral
writes descriptor changes without activation for an installer-managed handoff.`;
}

export interface ParsedSetupOptions {
  readonly nonInteractive: boolean;
  readonly deferServiceRestart: boolean;
  readonly devDir?: string;
  readonly port?: number;
}

export function parseSetupOptions(argv: readonly string[]): ParsedSetupOptions | null {
  const parsed: { nonInteractive: boolean; deferServiceRestart: boolean; devDir?: string; port?: number } = {
    nonInteractive: false,
    deferServiceRestart: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--non-interactive") parsed.nonInteractive = true;
    else if (arg === "--defer-service-restart") parsed.deferServiceRestart = true;
    else if (arg === "--dev-dir" && argv[i + 1]) parsed.devDir = argv[++i];
    else if (arg === "--port" && argv[i + 1]) {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
      parsed.port = port;
    } else return null;
  }
  if ((parsed.devDir !== undefined || parsed.port !== undefined) && !parsed.nonInteractive) return null;
  return parsed;
}

async function runSetup(args: readonly string[] = []): Promise<void> {
  const options = parseSetupOptions(args);
  if (!options) throw new Error(`invalid setup options. ${setupUsage()}`);
  const { setup } = await import("./setup.js");
  await setup(options);
}

export function shouldStartDashboard(argv: readonly string[]): boolean {
  return argv.length === 0;
}

export type ServiceCommandAction = "install" | "uninstall" | "stop" | "start" | "restart" | "status";

export interface ParsedServiceCommand {
  readonly action: ServiceCommandAction;
  readonly broker: boolean;
  readonly serverOnly: boolean;
}

export function parseServiceCommand(argv: readonly string[]): ParsedServiceCommand | null {
  const [action, ...flags] = argv;
  if (!action) return null;
  if (!["install", "uninstall", "stop", "start", "restart", "status"].includes(action)) return null;
  if (flags.some(flag => flag !== "--broker" && flag !== "--server-only")) return null;
  const broker = flags.includes("--broker");
  const serverOnly = flags.includes("--server-only");
  if (serverOnly && (action !== "restart" || broker)) return null;
  return { action: action as ServiceCommandAction, broker, serverOnly };
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
    await runSetup([]);
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

function isMachineHelpRequest(argv: readonly string[]): boolean {
  const help = argv.at(-1);
  if (!help || !HELP_ALIASES.has(help)) return false;
  const command = argv.slice(0, -1);
  if (command.length === 0) return true;
  const [family, action] = command;
  if (["list", "ls", "kill"].includes(family ?? "")) return command.length === 1;
  if (family === "session") {
    return command.length === 1 || (command.length === 2 && [
      "create", "open", "status", "read", "send", "wait", "prompt",
    ].includes(action ?? ""));
  }
  return family === "agent"
    && (command.length === 1 || (command.length === 2 && action === "spawn"));
}

function isMachineCommandSupported(argv: readonly string[]): boolean {
  const [family, action] = argv;
  if (["list", "ls", "kill"].includes(family ?? "")) return true;
  if (family === "session") {
    return ["create", "open", "status", "read", "send", "wait", "prompt"].includes(action ?? "");
  }
  return family === "agent" && action === "spawn";
}

function emitMachineFailure(
  failure: MachineTargetFailure,
  jsonOutput: boolean,
): never {
  if (jsonOutput) printJson({ ok: false, error: { code: failure.code, message: failure.message } });
  else printError(red(`  ${failure.message}`));
  process.exit(failure.exitCode);
}

function runServiceCommand(argv: readonly string[]): void {
  if (argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) {
    print(SERVICE_USAGE);
    return;
  }
  const serviceCommand = parseServiceCommand(argv.slice(1));
  if (!serviceCommand) {
    printError(`  ${SERVICE_USAGE}`);
    process.exit(1);
  }
  if (serviceCommand.action === "install") serviceInstall();
  else if (serviceCommand.action === "uninstall") serviceUninstall();
  else if (serviceCommand.action === "stop") serviceStop(serviceCommand.broker ? { broker: true } : {});
  else if (serviceCommand.action === "start") serviceStart();
  else if (serviceCommand.action === "restart") {
    const restarted = serviceCommand.serverOnly
      ? serviceRestart({ broker: false, skipBrokerSessionWarning: true })
      : serviceRestart(serviceCommand.broker ? { broker: true } : {});
    if (!restarted) process.exitCode = 1;
  } else if (serviceCommand.action === "status") serviceStatus();
}

async function runDoctorCommand(argv: readonly string[]): Promise<void> {
  if (argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) {
    print("Usage: wolfpack doctor [--json] [--fix]");
    return;
  }
  const flags = argv.slice(1);
  if (flags.some(flag => flag !== "--json" && flag !== "--fix")) throw new Error("Usage: wolfpack doctor [--json] [--fix]");
  process.exit(await doctor({ fix: flags.includes("--fix"), json: flags.includes("--json") }));
}

function runUninstallCommand(argv: readonly string[]): void {
  if (argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) {
    print("Usage: wolfpack uninstall --yes");
    return;
  }
  if (!hasUninstallConfirmationFlag(argv.slice(1))) {
    printError(red("  Refusing to uninstall without confirmation."));
    printError(dim("  This will recursively delete ~/.wolfpack/ (keys, secrets, config)."));
    printError(dim("  Re-run with: wolfpack uninstall --yes"));
    process.exit(1);
  }
  uninstall();
}

async function dispatchCommand(
  argv: readonly string[],
  target: VerifiedMachineTarget | undefined,
): Promise<void> {
  const [cmd] = argv;
  if (argv.length === 1 && HELP_ALIASES.has(cmd)) {
    print(topLevelUsage());
    return;
  }
  if (argv.length === 1 && (cmd === "--version" || cmd === "-V")) {
    print(pkg.version);
    return;
  }
  if (shouldStartDashboard(argv)) {
    await start();
    return;
  }
  if (cmd === "setup") {
    if (argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) print(setupUsage());
    else await runSetup(argv.slice(1));
    return;
  }
  if (cmd === "service") {
    runServiceCommand(argv);
    return;
  }
  if (cmd === "doctor") {
    await runDoctorCommand(argv);
    return;
  }
  if (cmd === "ls" || cmd === "list") process.exit(await lsSessions(argv.slice(1), target));
  if (cmd === "session") process.exit(await runSessionCommand(argv.slice(1), target));
  if (cmd === "agent") process.exit(await runAgentCommand(argv.slice(1), target));
  if (cmd === "kill") process.exit(await killSession(argv.slice(1), target));
  if (cmd === "logs") {
    if (argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) print("Usage: wolfpack logs [--follow] [--json] [--broker]");
    else process.exit(await logsCommand(argv.slice(1)));
    return;
  }
  if (cmd === "attach") {
    if (argv.length === 2 && HELP_ALIASES.has(argv[1] ?? "")) print("Usage: wolfpack attach [session] [--take-control] [--prefill full|none]");
    else process.exit(await attachCommand(argv.slice(1)));
    return;
  }
  if (cmd === "uninstall") {
    runUninstallCommand(argv);
    return;
  }
  printError(red(`  Unknown command: ${cmd}`));
  printError(dim("  Run 'wolfpack --help' for available commands."));
  process.exit(1);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const extracted = extractMachineSelector(rawArgv);
  if (!extracted.ok) emitMachineFailure(extracted.error, rawArgv.includes("--json"));
  const argv = [...extracted.argv];
  let target: VerifiedMachineTarget | undefined;
  if (extracted.selector !== undefined && !isMachineHelpRequest(argv)) {
    if (!isMachineCommandSupported(argv)) {
      emitMachineFailure({
        code: "INVALID_MACHINE_SELECTOR",
        message: "--machine is not supported for this command",
        exitCode: 2,
      }, argv.includes("--json"));
    }
    const verified = await verifyMachineTarget(extracted.selector, {
      tailscaleHostname: loadConfig()?.tailscaleHostname,
      jwt: issueJwt(),
    });
    if (!verified.ok) emitMachineFailure(verified.error, argv.includes("--json"));
    target = verified.target;
  }
  await dispatchCommand(argv, target);
}

// only run when executed directly, not when imported for tests
if (import.meta.main) {
  main().catch((e) => {
    printError(red(`  Fatal error: ${e.message || e}`));
    process.exit(1);
  });
}
