import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENT_STATUS_MANIFEST_PATH,
  AGENT_STATUS_TTL_MS,
  chooseAgentStatusSource,
  collectAgentStatus,
  collectAgentStatusSources,
  readLocalStatusManifest,
} from "../../src/server/agent-status.ts";

let projectDir: string;

function writeManifest(content: string): string {
  const manifestPath = join(projectDir, AGENT_STATUS_MANIFEST_PATH);
  mkdirSync(join(projectDir, ".wolfpack"), { recursive: true });
  writeFileSync(manifestPath, content);
  return manifestPath;
}

describe("agent status authority model", () => {
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "agent-status-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("uses explicit authority precedence before lower-tier fallback", () => {
    const selected = chooseAgentStatusSource([
      { state: "idle", authority: "fallback", freshness: "fresh", source: "screen-fallback", label: "log fallback" },
      { state: "running", authority: "manifest", freshness: "fresh", source: "local-manifest", label: "manifest" },
    ]);

    expect(selected.state).toBe("running");
    expect(selected.authority).toBe("manifest");
  });

  test("distinguishes missing manifest and falls back to log-derived status", () => {
    const sources = collectAgentStatusSources(projectDir, { state: "running" });
    expect(sources).toContainEqual(expect.objectContaining({
      authority: "manifest",
      freshness: "missing",
      source: "local-manifest",
    }));

    const selected = collectAgentStatus(projectDir, { state: "running" });
    expect(selected).toMatchObject({
      state: "running",
      authority: "fallback",
      freshness: "fresh",
    });
  });

  test("distinguishes malformed manifest and falls back", () => {
    writeManifest("{ nope");

    const manifest = readLocalStatusManifest(projectDir);
    expect(manifest.freshness).toBe("malformed");

    const selected = collectAgentStatus(projectDir, { state: "idle" });
    expect(selected.authority).toBe("fallback");
    expect(selected.state).toBe("idle");
  });

  test("selects stale manifest over fallback because authority outranks freshness", () => {
    const manifestPath = writeManifest(JSON.stringify({ state: "cleanup", observedAt: "2026-07-11T00:00:00Z" }));
    const old = new Date(Date.now() - AGENT_STATUS_TTL_MS - 10_000);
    utimesSync(manifestPath, old, old);

    const selected = collectAgentStatus(projectDir, { state: "running" });
    expect(selected).toMatchObject({
      state: "cleanup",
      authority: "manifest",
      freshness: "stale",
      stale: true,
    });
  });

  test("rejects manifest symlink escaping the project directory", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "agent-status-outside-"));
    try {
      writeFileSync(join(outsideDir, "agent-status.json"), JSON.stringify({ state: "done" }));
      symlinkSync(outsideDir, join(projectDir, ".wolfpack"));

      const manifest = readLocalStatusManifest(projectDir);
      expect(manifest.freshness).toBe("malformed");
      expect(manifest.message).toContain("under project directory");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
