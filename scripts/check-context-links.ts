import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Check declared navigation targets, not generated coverage or semantic freshness. */
export function checkContextLinks(root: string): string[] {
  const errors: string[] = [];
  root = realpathSync(root);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const target = (value: unknown, label: string): string | undefined => {
    if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") || value.split("/").includes("..") || /^[a-z]:/i.test(value)) {
      errors.push(`${label}: expected a nonempty repository-relative path`); return;
    }
    const path = resolve(root, value);
    try {
      const actual = realpathSync(path);
      const fromRoot = relative(root, actual);
      if (fromRoot.startsWith("../") || fromRoot === ".." || isAbsolute(fromRoot)) throw new Error("target escapes repository");
      if (!statSync(actual).isFile()) throw new Error("target is not a regular file");
      return actual;
    } catch (e) { errors.push(`${label}: ${value}: ${(e as Error).message}`); }
  };
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(resolve(root, "edc-context/manifest.json"), "utf8")); }
  catch (e) { return [`manifest: ${(e as Error).message}`]; }
  if (!object(manifest)) return ["manifest: expected an object"];
  const index = target(manifest.repoContextFile, "repoContextFile");
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) errors.push("modules: expected a nonempty array");
  else {
    const names = new Set<string>();
    for (const [i, module] of manifest.modules.entries()) {
      if (!object(module)) { errors.push(`modules[${i}]: expected an object`); continue; }
      if (typeof module.name !== "string" || !module.name || names.has(module.name)) errors.push(`modules[${i}]: missing or duplicate name`);
      else names.add(module.name);
      target(module.doc, `modules[${i}].doc`);
    }
  }
  // Reports are optional; only advertise files actually present in the checkout.
  if (manifest.reports !== undefined) {
    if (!object(manifest.reports)) errors.push("reports: expected an object");
    else for (const [name, path] of Object.entries(manifest.reports)) target(path, `reports.${name}`);
  }
  if (manifest.build !== undefined) {
    if (!object(manifest.build)) errors.push("build: expected an object");
    else target(manifest.build.buildInfoFile, "build.buildInfoFile");
  }
  if (index) {
    const markdown = readFileSync(index, "utf8");
    const refs = new Set<string>();
    for (const match of markdown.matchAll(/(?:`|\]\()((?:edc-context\/)?modules\/[^`\s)#]+\.md)(?:#[^`)\s]+)?(?:`|\))/g)) refs.add(match[1]!);
    for (const ref of refs) {
      const path = ref.startsWith("edc-context/") ? ref : relative(root, resolve(dirname(index), ref));
      target(path, "index module link");
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = checkContextLinks(process.cwd());
  if (errors.length) {
    console.error(`Context links: ${errors.length} error(s)\n${errors.join("\n")}`);
    process.exitCode = 1;
  } else console.log("Context links: all declared documents and index module links resolve");
}
