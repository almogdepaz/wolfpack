/**
 * `wolfpack doctor` checks for agent integrations (Pi Tasks, Claude Code channels).
 * Every probe is read-only; fixes are printed commands, never run by `--fix`.
 */
import type { CheckResult } from "./doctor.js";
import { PI_TASKS_MIGRATION_COMMANDS, findLegacyPiTasksSource, piAgentDirectory } from "./pi-integration.js";

const GROUP = "Integrations";

/** Warns when Pi still has the package under its pre-rename name. */
export function checkPiTasksPackage(agentDirectory: string = piAgentDirectory()): CheckResult[] {
  const legacySource = findLegacyPiTasksSource(agentDirectory);
  if (legacySource === undefined) return [];
  return [{
    name: "pi tasks package",
    group: GROUP,
    status: "warn",
    detail: `${legacySource} is installed under its old name`,
    fixHint: PI_TASKS_MIGRATION_COMMANDS.join(" && "),
  }];
}
