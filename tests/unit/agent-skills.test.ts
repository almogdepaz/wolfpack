import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

function bashFenceAfter(docs: string, marker: string): string {
  const markerIndex = docs.indexOf(marker);
  if (markerIndex < 0) throw new Error(`install marker not found: ${marker}`);
  const fenceMarker = "```bash\n";
  const fenceStart = docs.indexOf(fenceMarker, markerIndex);
  if (fenceStart < 0) throw new Error(`bash fence not found after: ${marker}`);
  const contentStart = fenceStart + fenceMarker.length;
  const fenceEnd = docs.indexOf("\n```", contentStart);
  if (fenceEnd < 0) throw new Error(`unterminated bash fence after: ${marker}`);
  return docs.slice(contentStart, fenceEnd);
}

interface ShellRun {
  readonly exitCode: number;
  readonly stderr: string;
}

function runInstallSnippet(snippet: string, home: string): ShellRun {
  const child = Bun.spawnSync([
    "/bin/bash",
    "-eu",
    "-o",
    "pipefail",
    "-c",
    snippet,
  ], {
    cwd: root,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stderr: child.stderr.toString(),
  };
}

describe("agent skills", () => {
  test("tailnet control skill documents safe opaque-context workflows", () => {
    const skill = readRepoFile("skills/wolfpack-tailnet-control/SKILL.md");

    expect(skill).toContain("Treat session selectors as opaque handles");
    expect(skill).toContain("explicit user intent");
    expect(skill).toContain("docs/session-control.md");
    expect(skill).not.toContain("wss://host/ws/pty?session=<name>");
    expect(skill).not.toContain("curl -fsS");
    expect(skill.split("\n").length).toBeLessThanOrEqual(80);
  });

  test("tailnet control skill distinguishes top-level sessions from child agents", () => {
    const skill = readRepoFile("skills/wolfpack-tailnet-control/SKILL.md");

    expect(skill).toContain("wolfpack session create <project>");
    expect(skill).toContain("wolfpack agent spawn <project>");
    expect(skill).toContain("top-level");
    expect(skill).toContain("child");
    expect(skill).toContain("one short prompt");
    expect(skill).not.toContain("wolfpack session open <project> --prompt '<instruction>' --json");
  });

  test("session-open docs preserve the tailnet/global trust boundary", () => {
    const skill = readRepoFile("skills/wolfpack-tailnet-control/SKILL.md");
    const readme = readRepoFile("README.md");
    const controlDocs = readRepoFile("docs/session-control.md");
    const identityDocs = readRepoFile("docs/session-identity.md");

    for (const content of [skill, readme, controlDocs, identityDocs]) {
      expect(content).toContain("ordinary global API auth policy");
      expect(content).toContain("no inter-session authorization layer");
    }
    expect(controlDocs).toContain("POST /api/session-open");
    expect(controlDocs).toContain("performs one `POST /api/session-open` request");
    expect(identityDocs).toContain("server derives the child harness");
  });

  test("skill docs point at existing repo references", () => {
    const skill = readRepoFile("skills/wolfpack-tailnet-control/SKILL.md");
    const references = [
      "README.md",
      "docs/broker-protocol.md",
      "docs/troubleshooting.md",
    ];

    for (const reference of references) {
      expect(skill).toContain(reference);
      expect(existsSync(join(root, reference))).toBe(true);
    }
  });

  test("main package and readme include bundled skill distribution docs", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { files?: string[] };
    const readme = readRepoFile("README.md");
    const docs = readRepoFile("docs/agent-skills.md");

    expect(pkg.files).toContain("skills");
    expect(pkg.files).toContain("docs/agent-skills.md");
    expect(readme).toContain("docs/agent-skills.md");
    expect(readme).toContain("all agent harnesses");
    expect(docs).toContain("The npm package includes `skills/`");
    expect(docs).toContain("prefer symlinking each desired Wolfpack skill");
  });

  test("readme and agent-skill docs install audited repository skills safely", () => {
    const readme = readRepoFile("README.md");
    const docs = readRepoFile("docs/agent-skills.md");

    for (const content of [readme, docs]) {
      expect(content).toContain("https://github.com/almogdepaz/wolfpack");
      expect(content).toContain("skills/wolfpack-tailnet-control/SKILL.md");
      expect(content).toContain("~/.pi/agent/skills/");
      expect(content).toContain("~/.agents/skills/");
      expect(content).toContain("~/.claude/skills/");
      expect(content).toContain("fresh agent context");
      expect(content).toContain("wolfpack session create <project>");
      expect(content).toContain("wolfpack agent spawn <project>");
      expect(content.toLowerCase()).toMatch(/platform\s+binaries do not expose skills as files/);
    }

    expect(docs).toContain("[ ! -e \"$DEST\" ]");
    expect(docs).toContain("ln -s \"$SOURCE\" \"$DEST\"");
    expect(docs).toContain("must be refreshed manually");
    expect(docs).not.toContain("rm -rf");
    expect(docs).not.toContain("ln -sf");
  });

  test("documents the opt-in Pi extension and skill ownership", () => {
    const readme = readRepoFile("README.md");
    const docs = readRepoFile("docs/agent-skills.md");

    for (const content of [readme, docs]) {
      expect(content).not.toContain("pi install npm:wolfpack-bridge");
      expect(content).toContain("pi install npm:@sgtbeatdown/pi-tasks");
      expect(content).toContain("`wolfpack-tailnet-control`");
      expect(content).toContain("`wolfpack-pi-task-delegation`");
      expect(content).toContain("`agent_task_*`");
      expect(content).toContain("`wolfpack setup`");
      expect(content.toLowerCase()).toContain("opt-in");
    }

    expect(readme).toContain("copies the bundled control skill");
    expect(docs).toContain("copies the bundled control skill");
  });

  test("standalone install fences succeed once and fail closed on rerun or missing source", () => {
    const docs = readRepoFile("docs/agent-skills.md");
    const tempRoot = mkdtempSync(join(tmpdir(), "wolfpack-skill-install-"));
    const workflows = [
      {
        name: "symlink",
        snippet: bashFenceAfter(docs, "For shared skill directories"),
        symbolic: true,
      },
      {
        name: "copy",
        snippet: bashFenceAfter(docs, "Copying is an alternative"),
        symbolic: false,
      },
    ] as const;

    try {
      for (const workflow of workflows) {
        const home = join(tempRoot, workflow.name);
        const source = join(home, "src/wolfpack/skills/wolfpack-tailnet-control");
        const destinationRoot = join(home, ".pi/agent/skills");
        const destination = join(destinationRoot, "wolfpack-tailnet-control");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "SKILL.md"), `${workflow.name} fixture\n`);
        expect(existsSync(destinationRoot)).toBe(false);

        const first = runInstallSnippet(workflow.snippet, home);
        expect(first).toEqual({ exitCode: 0, stderr: "" });
        expect(lstatSync(destination).isSymbolicLink()).toBe(workflow.symbolic);
        expect(readFileSync(join(destination, "SKILL.md"), "utf-8")).toBe(`${workflow.name} fixture\n`);

        if (workflow.symbolic) {
          expect(readlinkSync(destination)).toBe(source);
        } else {
          writeFileSync(join(destination, "preserve-me"), "local\n");
        }
        const rerun = runInstallSnippet(workflow.snippet, home);
        expect(rerun.exitCode).not.toBe(0);
        expect(rerun.stderr).toContain(`refusing to replace existing skill: ${destination}`);
        if (workflow.symbolic) {
          expect(readlinkSync(destination)).toBe(source);
        } else {
          expect(readFileSync(join(destination, "preserve-me"), "utf-8")).toBe("local\n");
        }

        const missingHome = join(tempRoot, `${workflow.name}-missing`);
        const missingSource = join(missingHome, "src/wolfpack/skills/wolfpack-tailnet-control");
        const missingRoot = join(missingHome, ".pi/agent/skills");
        const missingDestination = join(missingRoot, "wolfpack-tailnet-control");
        mkdirSync(missingHome, { recursive: true });
        const missing = runInstallSnippet(workflow.snippet, missingHome);
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr.trim()).toBe(`skill source not found: ${missingSource}`);
        expect(existsSync(missingRoot)).toBe(false);
        expect(existsSync(missingDestination)).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
