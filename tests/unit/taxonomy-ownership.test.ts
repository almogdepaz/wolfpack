import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { AGENT_KIND } from "../../src/agent-kind";
import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
} from "../../src/agent-status-contract";
import { TERMINAL_PREFILL_MODE } from "../../src/terminal-prefill";

type TaxonomyRule = {
  readonly name: string;
  readonly owner: string;
  readonly members: readonly string[];
  readonly context: RegExp;
};

const ROOT = join(import.meta.dirname, "..", "..");

function taxonomyMembers(...groups: ReadonlyArray<Readonly<Record<string, string | { readonly id: string }>>>): readonly string[] {
  return groups.flatMap(group => Object.values(group).map(value => typeof value === "string" ? value : value.id));
}

const TAXONOMIES: readonly TaxonomyRule[] = [
  { name: "agent-kind", owner: "src/agent-kind.ts", members: taxonomyMembers(AGENT_KIND), context: /agent|harness/i },
  { name: "terminal-prefill-mode", owner: "src/terminal-prefill.ts", members: taxonomyMembers(TERMINAL_PREFILL_MODE), context: /prefill/i },
  { name: "agent-status-source", owner: "src/agent-status-contract.ts", members: taxonomyMembers(AGENT_STATUS_AUTHORITY, AGENT_STATUS_FRESHNESS, AGENT_STATUS_SOURCE), context: /AgentStatus|statusSource|freshness|authority|candidate|readStructuredStatusFile/ },
];

const EXCLUDED_DIRS = new Set(["dist", "node_modules", "tests", "broker", "edc-context", ".plans", "plans"]);

function walk(dir: string): string[] {
  const entries = readdirSync(dir).flatMap(entry => {
    if (EXCLUDED_DIRS.has(entry)) return [];
    const absolute = join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) return walk(absolute);
    return [absolute];
  });
  return entries;
}

const SOURCE_FILES = walk(ROOT)
  .map(path => relative(ROOT, path).replaceAll("\\", "/"))
  .filter(path => /^(src|public|scripts)\/.+\.(ts|js)$/.test(path))
  .filter(path => !path.endsWith(".bundle.js") && path !== "src/public-assets.ts");

function lineAndColumn(text: string, pos: number): string {
  const prefix = text.slice(0, pos);
  const lines = prefix.split("\n");
  return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
}

function hasRuleSiteAncestor(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isBinaryExpression(current)) return true;
    if (ts.isCaseClause(current)) return true;
    if (ts.isPropertyAssignment(current) && current.name === node) return true;
    if (ts.isConditionalExpression(current)) return true;
    if (ts.isArrayLiteralExpression(current)) return true;
    current = current.parent;
  }
  return false;
}

function surroundingText(source: ts.SourceFile, node: ts.Node): string {
  const start = Math.max(0, node.getStart(source) - 120);
  const end = Math.min(source.text.length, node.getEnd() + 120);
  return source.text.slice(start, end);
}

function taxonomyBypasses(rule: TaxonomyRule): string[] {
  const memberSet = new Set(rule.members);
  const failures: string[] = [];
  if (!existsSync(join(ROOT, rule.owner)) || SOURCE_FILES.filter(path => path === rule.owner).length !== 1) {
    failures.push(`${rule.name}: expected exactly one owner at ${rule.owner}`);
  }
  for (const path of SOURCE_FILES) {
    if (path === rule.owner) continue;
    const text = readFileSync(join(ROOT, path), "utf-8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && memberSet.has(node.text)) {
        if (hasRuleSiteAncestor(node) && rule.context.test(surroundingText(source, node))) {
          failures.push(`${path}:${lineAndColumn(text, node.getStart(source))}: raw ${rule.name} literal ${JSON.stringify(node.text)}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

describe("taxonomy ownership", () => {
  for (const rule of TAXONOMIES) {
    test(`${rule.name} rule sites derive from ${rule.owner}`, () => {
      expect(taxonomyBypasses(rule)).toEqual([]);
    });
  }
});
