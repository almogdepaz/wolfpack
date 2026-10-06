import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dirname, "..", "..");
test("packed SDK supports strict outside-checkout TypeScript and Node ESM consumers", () => {
  const stage = mkdtempSync(join(tmpdir(), "wolfpack-sdk-consumer-"));
  try {
    const env = { ...process.env, HOME: join(stage, "home"), npm_config_cache: join(stage, "cache") }; mkdirSync(env.HOME, { recursive: true });
    const pack = Bun.spawnSync(["npm", "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", stage], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(pack.exitCode).toBe(0); const archive = JSON.parse(pack.stdout.toString())[0].filename;
    expect(Bun.spawnSync(["tar", "-xzf", join(stage, archive), "-C", stage]).exitCode).toBe(0); mkdirSync(join(stage, "node_modules")); symlinkSync("../package", join(stage, "node_modules", "wolfpack-bridge"));
    writeFileSync(join(stage, "consumer.mts"), `import { leadStackLayout, type ExtensionViewContext, type ContextViewContribution } from "wolfpack-bridge/extensions";
const view: ContextViewContribution = { id: "sample", title: "Sample", mount(container, context) { container.textContent = context.scope.sessionId; return { dispose() {} }; } };
function probe(context: ExtensionViewContext) { // @ts-expect-error auth is not public
 context.authToken; // @ts-expect-error UUID is a string
 const invalid: number = context.scope.sessionId; }
leadStackLayout({ panes: [{ id: "one" }], selectedPaneId: "one", viewport: { width: 1, height: 1 } });\n`);
    writeFileSync(join(stage, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2022", lib: ["ES2022", "DOM"], types: [], skipLibCheck: false }, files: ["consumer.mts"] }));
    const typed = Bun.spawnSync(["node", join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(stage, "tsconfig.json")], { cwd: stage, env, stdout: "pipe", stderr: "pipe" }); expect(typed.exitCode).toBe(0);
    const executed = Bun.spawnSync(["node", "--input-type=module", "-e", `import {leadStackLayout} from "wolfpack-bridge/extensions"; if (leadStackLayout({panes:[{id:"one"}],selectedPaneId:"one",viewport:{width:1,height:1}}).version !== 1) throw Error("bad SDK")`], { cwd: stage, env, stdout: "pipe", stderr: "pipe" }); expect(executed.exitCode).toBe(0);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}, 20_000);
