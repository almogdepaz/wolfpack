import { print, printError, printJson } from "./formatting.ts";
import { getExtensionRuntime } from "../extensions/runtime.ts";

export function extensionsUsage(): string { return "Usage: wolfpack extensions install <absolute-directory|npm:name@version> --trust-browser-code [--skills pi]\n       wolfpack extensions list [--json]\n       wolfpack extensions enable|disable|update|remove|purge|rollback <extension-id> [--skills-root <path>]"; }
function validId(value: string | undefined): value is string { return !!value && /^[a-z][a-z0-9-]{0,63}$/.test(value); }
export async function extensionsCommand(argv: readonly string[]): Promise<number> {
  const [action, first, ...rest] = argv; const runtime = getExtensionRuntime();
  try {
    if (action === "list" && (first === undefined || first === "--json") && rest.length === 0) { const value = runtime.catalog(false); if (first === "--json") printJson(value); else for (const item of value.installations) print(`${item.extensionId}\t${item.package.version}\t${item.enabled ? "enabled" : "disabled"}\t${item.installationId}`); return 0; }
    if (action === "install") { const flags = new Set(rest); const skills = flags.has("--skills") && rest[rest.indexOf("--skills") + 1] === "pi"; if (!first || !flags.has("--trust-browser-code") || [...flags].some((flag) => !["--trust-browser-code", "--skills", "pi"].includes(flag))) throw new Error("install requires source and --trust-browser-code; --skills pi is optional"); const result = await runtime.install({ source: first, trustBrowserCode: true, ...(skills ? { skillsRoot: process.env.WOLFPACK_PI_SKILLS_ROOT ?? `${process.env.HOME}/.pi/agent/skills` } : {}) }); printJson({ installation: result.installation, skills: result.skills }); return 0; }
    if (["enable", "disable", "rollback"].includes(action ?? "") && validId(first) && rest.length === 0) { printJson(action === "rollback" ? runtime.rollback(first) : runtime.setEnabled(first, action === "enable")); return 0; }
    if (action === "purge" && validId(first) && rest.length === 0) { runtime.purge(first); printJson({ ok: true, purged: first }); return 0; }
    if (action === "update" && first && rest.includes("--trust-browser-code")) { const source = first; const skillsAt = rest.indexOf("--skills"); const skillsRoot = skillsAt >= 0 && rest[skillsAt + 1] === "pi" ? process.env.WOLFPACK_PI_SKILLS_ROOT ?? `${process.env.HOME}/.pi/agent/skills` : undefined; const result = await runtime.install({ source, trustBrowserCode: true, ...(skillsRoot ? { skillsRoot } : {}) }); printJson(result); return 0; }
    if (action === "remove" && validId(first) && (rest.length === 0 || (rest.length === 2 && rest[0] === "--skills-root" && rest[1]))) { printJson({ skills: runtime.remove(first, rest[1]) }); return 0; }
    throw new Error(extensionsUsage());
  } catch (error) { printError(error instanceof Error ? error.message : String(error)); return 1; }
}
