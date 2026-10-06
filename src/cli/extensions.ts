import { AGENT_KIND } from "../agent-kind.ts";
import { getExtensionRuntime } from "../extensions/runtime.ts";
import { print, printError, printJson } from "./formatting.ts";

export function extensionsUsage(): string { return `Usage: wolfpack extensions install <absolute-directory|npm:name@version> --trust-browser-code [--skills ${AGENT_KIND.PI.id}]\n       wolfpack extensions update <absolute-directory|npm:name@version> --trust-browser-code [--skills ${AGENT_KIND.PI.id}]\n       wolfpack extensions list [--json]\n       wolfpack extensions enable|disable|rollback <extension-id>\n       wolfpack extensions remove <extension-id> [--skills-root <path>]\n       wolfpack extensions purge <extension-id>`; }
function validId(value: string | undefined): value is string { return !!value && /^[a-z][a-z0-9-]{0,63}$/.test(value); }
function skillsRequested(flags: readonly string[]): boolean | undefined { const trust = flags.filter((flag) => flag === "--trust-browser-code"); const skill = flags.indexOf("--skills"); if (trust.length !== 1) return undefined; if (skill < 0) return flags.length === 1 ? false : undefined; return flags.length === 3 && skill + 1 < flags.length && flags[skill + 1] === AGENT_KIND.PI.id ? true : undefined; }
export async function extensionsCommand(argv: readonly string[]): Promise<number> {
  const [action, first, ...rest] = argv; const runtime = getExtensionRuntime();
  try {
    if (action === "list" && (first === undefined || first === "--json") && rest.length === 0) { const value = runtime.catalog(false); if (first === "--json") printJson(value); else for (const item of value.installations) print(`${item.extensionId}\t${item.package.version}\t${item.enabled ? "enabled" : "disabled"}\t${item.installationId}`); return 0; }
    if (action === "install") { const skills = skillsRequested(rest); if (!first || skills === undefined) throw new Error(`install requires source and --trust-browser-code; --skills ${AGENT_KIND.PI.id} is optional`); const result = await runtime.install({ source: first, trustBrowserCode: true, ...(skills ? { skillsRoot: process.env.WOLFPACK_PI_SKILLS_ROOT ?? `${process.env.HOME}/.pi/agent/skills` } : {}) }); printJson({ installation: result.installation, skills: result.skills }); return 0; }
    if (["enable", "disable", "rollback"].includes(action ?? "") && validId(first) && rest.length === 0) { printJson(action === "rollback" ? runtime.rollback(first) : runtime.setEnabled(first, action === "enable")); return 0; }
    if (action === "purge" && validId(first) && rest.length === 0) { runtime.purge(first); printJson({ ok: true, purged: first }); return 0; }
    if (action === "update") { const skills = skillsRequested(rest); if (!first || skills === undefined) throw new Error(`update requires source and --trust-browser-code; --skills ${AGENT_KIND.PI.id} is optional`); const result = await runtime.install({ source: first, trustBrowserCode: true, ...(skills ? { skillsRoot: process.env.WOLFPACK_PI_SKILLS_ROOT ?? `${process.env.HOME}/.pi/agent/skills` } : {}) }); printJson(result); return 0; }
    if (action === "remove" && validId(first) && (rest.length === 0 || (rest.length === 2 && rest[0] === "--skills-root" && rest[1]))) { printJson({ skills: runtime.remove(first, rest[1]) }); return 0; }
    throw new Error(extensionsUsage());
  } catch (error) { printError(error instanceof Error ? error.message : String(error)); return 1; }
}
