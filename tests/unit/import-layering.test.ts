import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Inspect runtime edges without evaluating modules or starting their services.
const root = resolve(import.meta.dir, "../..");
const files = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })]
  .filter(file => !file.endsWith(".d.ts")).sort();
const fileSet = new Set(files);
const graph = new Map<string, string[]>();
for (const file of files) {
  const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
  const imports = transpiler.scanImports(readFileSync(join(root, file), "utf8").replace(/^#![^\n]*\n/, ""));
  const targets = new Set<string>();
  for (const { path: specifier } of imports) {
    if (!specifier.startsWith(".")) continue;
    const path = relative(root, resolve(root, dirname(file), specifier));
    const target = [path, path.replace(/\.js$/, ".ts"), path.replace(/\.jsx$/, ".tsx"),
      `${path}.ts`, `${path}.tsx`, join(path, "index.ts"), join(path, "index.tsx")]
      .find(candidate => fileSet.has(candidate));
    if (target) targets.add(target);
  }
  graph.set(file, [...targets].sort());
}
const edges = [...graph].flatMap(([source, targets]) => targets.map(target => ({ source, target })));
const format = ({ source, target }: { source: string; target: string }) => `${source} -> ${target}`;

test("server runtime imports do not depend on CLI modules", () => {
  expect(edges.filter(edge => edge.source.startsWith("src/server/") && edge.target.startsWith("src/cli/")).map(format)).toEqual([]);
});

test("lower layers have only the declared relay peer transport server dependency", () => {
  expect(edges.filter(edge => /^src\/(tasks|task-relay|extensions|control-api)\//.test(edge.source)
    && edge.target.startsWith("src/server/")).map(format).sort()).toEqual([
    "src/task-relay/gateway.ts -> src/server/relay-peer-transport.ts",
  ]);
});

test("no runtime import cycle passes through tasks or task-relay", () => {
  const cycles: string[][] = [];
  for (const origin of files.filter(file => /^src\/(tasks|task-relay)\//.test(file))) {
    const visited = new Set<string>();
    function findCycle(node: string, path: string[]): string[] | undefined {
      if (node === origin) return path;
      if (visited.has(node)) return;
      visited.add(node);
      for (const target of graph.get(node) ?? []) {
        const cycle = findCycle(target, [...path, target]);
        if (cycle) return cycle;
      }
    }
    for (const target of graph.get(origin) ?? []) {
      const cycle = findCycle(target, [origin, target]);
      if (cycle) { cycles.push(cycle); break; }
    }
  }
  expect(cycles).toEqual([]);
});
