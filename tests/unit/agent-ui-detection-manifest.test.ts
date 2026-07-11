import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acceptAgentUiManifestUpdate,
  AGENT_UI_MANIFEST_MAX_BYTES,
  bundledAgentUiDetectionManifest,
  detectAgentUiStatusFromManifests,
  loadAgentUiDetectionManifests,
  validateAgentUiDetectionManifest,
} from "../../src/agent-ui-detection-manifest.js";
import { parseRalphLog } from "../../src/server/ralph.js";
import { startFakeRalph, stopFakeRalph, type FakeRalph } from "../helpers/fake-ralph-pid.js";

let fakeRalph: FakeRalph | null = null;
let fakeRalphPid = process.pid;
let tmpDir: string;
const originalUserManifest = process.env.WOLFPACK_AGENT_UI_MANIFEST;
const originalCachedManifest = process.env.WOLFPACK_AGENT_UI_MANIFEST_CACHE;

beforeAll(() => {
  fakeRalph = startFakeRalph();
  fakeRalphPid = fakeRalph.pid;
});

afterAll(() => {
  if (fakeRalph) stopFakeRalph(fakeRalph);
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-ui-manifest-"));
  delete process.env.WOLFPACK_AGENT_UI_MANIFEST;
  delete process.env.WOLFPACK_AGENT_UI_MANIFEST_CACHE;
});

afterEach(() => {
  if (originalUserManifest === undefined) delete process.env.WOLFPACK_AGENT_UI_MANIFEST;
  else process.env.WOLFPACK_AGENT_UI_MANIFEST = originalUserManifest;
  if (originalCachedManifest === undefined) delete process.env.WOLFPACK_AGENT_UI_MANIFEST_CACHE;
  else process.env.WOLFPACK_AGENT_UI_MANIFEST_CACHE = originalCachedManifest;
  rmSync(tmpDir, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    manifestId: "test.ralph",
    version: "2026.07.11",
    generatedAt: "2026-07-11T00:00:00.000Z",
    validUntil: "2027-07-11T00:00:00.000Z",
    agents: [
      {
        id: "ralph",
        versionConstraints: ["*"],
        rules: [
          {
            id: "test.cleanup",
            status: "cleanup",
            confidence: 0.91,
            contains: ["Custom Cleanup Started"],
            notContains: ["Custom Cleanup Done"],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function writeManifestFile(name: string, value: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function writeProjectLog(content: string): string {
  const projectDir = join(tmpDir, "project");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "PLAN.md"), "- [ ] task\n");
  writeFileSync(join(projectDir, "progress.txt"), "");
  writeFileSync(join(projectDir, ".ralph.log"), [
    "🥋 ralph — 5 iterations",
    "agent: claude",
    "plan: PLAN.md",
    "progress: progress.txt",
    "phase_cleanup: on",
    "phase_audit_fix: off",
    `pid: ${fakeRalphPid}`,
    "started: Mon Jan 01 2024 12:00:00",
    "",
    content,
  ].join("\n"));
  return projectDir;
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("agent UI detection manifests", () => {
  test("bundled manifest provides fallback detection below explicit hooks", () => {
    const match = detectAgentUiStatusFromManifests(
      [bundledAgentUiDetectionManifest()],
      "ralph",
      "worker says Wax Off is underway",
    );

    expect(match?.status).toBe("cleanup");
    expect(match?.diagnostics.sourceKind).toBe("bundled");
    expect(match?.diagnostics.matchedRule).toBe("ralph.cleanup.wax-off");
  });

  test("user manifests override cached and bundled manifests", () => {
    const cachedPath = writeManifestFile("cached.json", manifest({
      manifestId: "cached.ralph",
      agents: [{ id: "ralph", rules: [{ id: "cached.audit", status: "audit", confidence: 0.5, contains: ["same token"] }] }],
    }));
    const userPath = writeManifestFile("user.json", manifest({
      manifestId: "user.ralph",
      agents: [{ id: "ralph", rules: [{ id: "user.cleanup", status: "cleanup", confidence: 0.5, contains: ["same token"] }] }],
    }));

    const loaded = loadAgentUiDetectionManifests({
      cachedManifestPath: cachedPath,
      userManifestPaths: [userPath],
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    const match = detectAgentUiStatusFromManifests(loaded, "ralph", "same token");

    expect(match?.status).toBe("cleanup");
    expect(match?.diagnostics.sourceKind).toBe("user");
    expect(match?.diagnostics.manifestId).toBe("user.ralph");
  });

  test("malformed and oversized local manifests fail closed to bundled defaults", () => {
    const malformedPath = join(tmpDir, "bad.json");
    writeFileSync(malformedPath, "{");
    const oversizedPath = join(tmpDir, "oversized.json");
    writeFileSync(oversizedPath, "x".repeat(AGENT_UI_MANIFEST_MAX_BYTES + 1));

    const loaded = loadAgentUiDetectionManifests({
      userManifestPaths: [malformedPath, oversizedPath],
      now: new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(loaded.map((entry) => entry.sourceKind)).toEqual(["bundled"]);
  });

  test("rejects executable-looking manifest fields", () => {
    const result = validateAgentUiDetectionManifest(
      manifest({ script: "rm -rf ." }),
      new Date("2026-07-11T00:00:00.000Z"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("manifest contains executable fields");
  });

  test("rejects stale manifests", () => {
    const result = validateAgentUiDetectionManifest(
      manifest({ validUntil: "2026-01-01T00:00:00.000Z" }),
      new Date("2026-07-11T00:00:00.000Z"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale manifest");
  });

  test("accepts cached updates only with trusted content type and matching sha256", () => {
    const body = JSON.stringify(manifest({ manifestId: "remote.ralph" }));
    const cachePath = join(tmpDir, "cache", "agent-ui.json");
    const rejectedType = acceptAgentUiManifestUpdate({
      bytes: body,
      expectedSha256: sha256(body),
      contentType: "text/plain",
      cachePath,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    const rejectedHash = acceptAgentUiManifestUpdate({
      bytes: body,
      expectedSha256: "0".repeat(64),
      contentType: "application/json",
      cachePath,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    const accepted = acceptAgentUiManifestUpdate({
      bytes: body,
      expectedSha256: sha256(body),
      contentType: "application/json; charset=utf-8",
      cachePath,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(rejectedType).toEqual({ accepted: false, reason: "unsupported content type" });
    expect(rejectedHash).toEqual({ accepted: false, reason: "sha256 mismatch" });
    expect(accepted.accepted).toBe(true);
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8")).manifestId).toBe("remote.ralph");
  });

  test("parseRalphLog uses manifests only when explicit phase markers do not match", () => {
    const userPath = writeManifestFile("user.json", manifest());
    process.env.WOLFPACK_AGENT_UI_MANIFEST = userPath;
    const fallbackProject = writeProjectLog("Custom Cleanup Started\nworking");
    const fallback = parseRalphLog(fallbackProject);

    expect(fallback?.cleanup).toBe(true);
    expect(fallback?.detectionManifest?.sourceKind).toBe("user");
    expect(fallback?.detectionManifest?.matchedRule).toBe("test.cleanup");

    const explicitProject = writeProjectLog("=== 🥋 Wax Inspect — starting audit+fix — now ===\nCustom Cleanup Started");
    const explicit = parseRalphLog(explicitProject);

    expect(explicit?.audit).toBe(true);
    expect(explicit?.cleanup).toBe(false);
    expect(explicit?.detectionManifest).toBeUndefined();
  });
});
