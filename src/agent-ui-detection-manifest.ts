import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { AGENT_KIND } from "./agent-kind.js";
import { basename, dirname, join } from "node:path";

export const AGENT_UI_MANIFEST_SCHEMA_VERSION = 1;
export const AGENT_UI_MANIFEST_MAX_BYTES = 64 * 1024;
export const AGENT_UI_PATTERN_MAX_CHARS = 256;
export const AGENT_UI_MAX_RULES = 64;

export type AgentUiStatus = "audit" | "cleanup";
export type AgentUiManifestSourceKind = "bundled" | "user" | "cached";

export interface AgentUiDetectionRule {
  readonly id: string;
  readonly status: AgentUiStatus;
  readonly confidence: number;
  readonly contains?: readonly string[];
  readonly startsWith?: readonly string[];
  readonly notContains?: readonly string[];
}

export interface AgentUiDetectionAgent {
  readonly id: string;
  readonly versionConstraints?: readonly string[];
  readonly rules: readonly AgentUiDetectionRule[];
}

export interface AgentUiDetectionManifest {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly validUntil?: string;
  readonly agents: readonly AgentUiDetectionAgent[];
}

export interface LoadedAgentUiDetectionManifest {
  readonly manifest: AgentUiDetectionManifest;
  readonly source: string;
  readonly sourceKind: AgentUiManifestSourceKind;
}

export interface AgentUiDetectionDiagnostics {
  readonly manifestId: string;
  readonly version: string;
  readonly source: string;
  readonly sourceKind: AgentUiManifestSourceKind;
  readonly matchedRule?: string;
  readonly confidence?: number;
}

export interface AgentUiDetectionMatch {
  readonly status: AgentUiStatus;
  readonly diagnostics: AgentUiDetectionDiagnostics;
}

export interface LoadAgentUiDetectionManifestsOptions {
  readonly userManifestPaths?: readonly string[];
  readonly cachedManifestPath?: string;
  readonly now?: Date;
}

export interface AcceptAgentUiManifestUpdateOptions {
  readonly bytes: string | Buffer;
  readonly expectedSha256: string;
  readonly contentType: string;
  readonly cachePath: string;
  readonly now?: Date;
}

export interface AcceptAgentUiManifestUpdateResult {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly manifest?: LoadedAgentUiDetectionManifest;
}

const BUNDLED_MANIFEST: AgentUiDetectionManifest = {
  schemaVersion: AGENT_UI_MANIFEST_SCHEMA_VERSION,
  manifestId: "wolfpack.bundled",
  version: "2026.07.11",
  generatedAt: "2026-07-11T00:00:00.000Z",
  agents: [],
};

const ALLOWED_CONTENT_TYPES = new Set([
  "application/json",
  "application/manifest+json",
  "text/json",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d{3})?z$/i;
const SAFE_ID_RE = /^[a-z0-9._-]{1,80}$/;
const SAFE_VERSION_RE = /^[a-z0-9._:+-]{1,80}$/i;
const FORBIDDEN_KEYS = new Set(["code", "command", "commands", "eval", "exec", "script", AGENT_KIND.SHELL]);

export function bundledAgentUiDetectionManifest(): LoadedAgentUiDetectionManifest {
  return {
    manifest: BUNDLED_MANIFEST,
    source: "bundled",
    sourceKind: "bundled",
  };
}

export function loadAgentUiDetectionManifests(
  options: LoadAgentUiDetectionManifestsOptions = {},
): LoadedAgentUiDetectionManifest[] {
  const now = options.now ?? new Date();
  const loaded: LoadedAgentUiDetectionManifest[] = [bundledAgentUiDetectionManifest()];

  if (options.cachedManifestPath) {
    const cached = loadManifestFile(options.cachedManifestPath, "cached", now);
    if (cached) loaded.push(cached);
  }

  for (const path of options.userManifestPaths ?? []) {
    const user = loadManifestFile(path, "user", now);
    if (user) loaded.push(user);
  }

  return loaded;
}

export function detectAgentUiStatusFromManifests(
  manifests: readonly LoadedAgentUiDetectionManifest[],
  agentId: string,
  content: string,
): AgentUiDetectionMatch | null {
  for (const loaded of [...manifests].reverse()) {
    const agent = loaded.manifest.agents.find((candidate) => candidate.id === agentId);
    if (!agent) continue;

    let best: { rule: AgentUiDetectionRule; score: number } | null = null;
    for (const rule of agent.rules) {
      if (!ruleMatches(rule, content)) continue;
      if (!best || rule.confidence > best.score) best = { rule, score: rule.confidence };
    }

    if (best) {
      return {
        status: best.rule.status,
        diagnostics: {
          manifestId: loaded.manifest.manifestId,
          version: loaded.manifest.version,
          source: loaded.source,
          sourceKind: loaded.sourceKind,
          matchedRule: best.rule.id,
          confidence: best.rule.confidence,
        },
      };
    }
  }

  return null;
}

export function acceptAgentUiManifestUpdate(
  options: AcceptAgentUiManifestUpdateOptions,
): AcceptAgentUiManifestUpdateResult {
  const contentType = options.contentType.split(";")[0]?.trim().toLowerCase();
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return { accepted: false, reason: "unsupported content type" };
  }

  const bytes = Buffer.isBuffer(options.bytes) ? options.bytes : Buffer.from(options.bytes, "utf-8");
  if (bytes.byteLength > AGENT_UI_MANIFEST_MAX_BYTES) {
    return { accepted: false, reason: "manifest too large" };
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (!constantTimeHexEqual(actualSha256, options.expectedSha256)) {
    return { accepted: false, reason: "sha256 mismatch" };
  }

  const parsed = parseManifestText(bytes.toString("utf-8"), options.now ?? new Date());
  if (!parsed.ok) return { accepted: false, reason: parsed.reason };

  mkdirSync(dirname(options.cachePath), { recursive: true, mode: 0o700 });
  const tmpPath = join(dirname(options.cachePath), `.${basename(options.cachePath)}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, bytes, { mode: 0o600 });
  renameSync(tmpPath, options.cachePath);

  return {
    accepted: true,
    manifest: {
      manifest: parsed.manifest,
      source: options.cachePath,
      sourceKind: "cached",
    },
  };
}

export function validateAgentUiDetectionManifest(
  value: unknown,
  now: Date = new Date(),
): { ok: true; manifest: AgentUiDetectionManifest } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "manifest must be an object" };
  if (hasForbiddenKey(value)) return { ok: false, reason: "manifest contains executable fields" };
  if (value.schemaVersion !== AGENT_UI_MANIFEST_SCHEMA_VERSION) return { ok: false, reason: "unsupported schema version" };
  if (!isSafeId(value.manifestId)) return { ok: false, reason: "invalid manifest id" };
  if (!isSafeVersion(value.version)) return { ok: false, reason: "invalid manifest version" };
  if (!isIsoDate(value.generatedAt)) return { ok: false, reason: "invalid generatedAt" };
  if (value.validUntil !== undefined && !isIsoDate(value.validUntil)) return { ok: false, reason: "invalid validUntil" };
  if (value.validUntil && Date.parse(value.validUntil) <= now.getTime()) return { ok: false, reason: "stale manifest" };
  if (!Array.isArray(value.agents) || value.agents.length === 0) return { ok: false, reason: "agents required" };

  const agents: AgentUiDetectionAgent[] = [];
  let ruleCount = 0;
  for (const agentValue of value.agents) {
    if (!isPlainObject(agentValue)) return { ok: false, reason: "agent must be an object" };
    if (!isSafeId(agentValue.id)) return { ok: false, reason: "invalid agent id" };
    if (agentValue.versionConstraints !== undefined && !isStringArray(agentValue.versionConstraints, 12)) {
      return { ok: false, reason: "invalid version constraints" };
    }
    if (!Array.isArray(agentValue.rules) || agentValue.rules.length === 0) return { ok: false, reason: "rules required" };

    const rules: AgentUiDetectionRule[] = [];
    for (const ruleValue of agentValue.rules) {
      ruleCount++;
      if (ruleCount > AGENT_UI_MAX_RULES) return { ok: false, reason: "too many rules" };
      const rule = validateRule(ruleValue);
      if (!rule.ok) return rule;
      rules.push(rule.rule);
    }

    agents.push({
      id: agentValue.id,
      versionConstraints: agentValue.versionConstraints,
      rules,
    });
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: AGENT_UI_MANIFEST_SCHEMA_VERSION,
      manifestId: value.manifestId,
      version: value.version,
      generatedAt: value.generatedAt,
      validUntil: value.validUntil,
      agents,
    },
  };
}

function loadManifestFile(
  path: string,
  sourceKind: AgentUiManifestSourceKind,
  now: Date,
): LoadedAgentUiDetectionManifest | null {
  try {
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    if (bytes.byteLength > AGENT_UI_MANIFEST_MAX_BYTES) return null;
    const parsed = parseManifestText(bytes.toString("utf-8"), now);
    if (!parsed.ok) return null;
    return { manifest: parsed.manifest, source: path, sourceKind };
  } catch {
    return null;
  }
}

function parseManifestText(
  text: string,
  now: Date,
): { ok: true; manifest: AgentUiDetectionManifest } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  return validateAgentUiDetectionManifest(value, now);
}

function validateRule(
  value: unknown,
): { ok: true; rule: AgentUiDetectionRule } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "rule must be an object" };
  if (!isSafeId(value.id)) return { ok: false, reason: "invalid rule id" };
  if (value.status !== "audit" && value.status !== "cleanup") return { ok: false, reason: "invalid status" };
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    return { ok: false, reason: "invalid confidence" };
  }
  if (value.contains !== undefined && !isPatternArray(value.contains)) return { ok: false, reason: "invalid contains patterns" };
  if (value.startsWith !== undefined && !isPatternArray(value.startsWith)) return { ok: false, reason: "invalid startsWith patterns" };
  if (value.notContains !== undefined && !isPatternArray(value.notContains)) return { ok: false, reason: "invalid notContains patterns" };
  if (!value.contains && !value.startsWith) return { ok: false, reason: "positive pattern required" };

  return {
    ok: true,
    rule: {
      id: value.id,
      status: value.status,
      confidence: value.confidence,
      contains: value.contains,
      startsWith: value.startsWith,
      notContains: value.notContains,
    },
  };
}

function ruleMatches(rule: AgentUiDetectionRule, content: string): boolean {
  for (const needle of rule.contains ?? []) {
    if (!content.includes(needle)) return false;
  }
  for (const prefix of rule.startsWith ?? []) {
    if (!content.split("\n").some((line) => line.startsWith(prefix))) return false;
  }
  for (const needle of rule.notContains ?? []) {
    if (content.includes(needle)) return false;
  }
  return true;
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
    if (hasForbiddenKey(child)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

function isSafeVersion(value: unknown): value is string {
  return typeof value === "string" && SAFE_VERSION_RE.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= AGENT_UI_PATTERN_MAX_CHARS);
}

function isPatternArray(value: unknown): value is string[] {
  return isStringArray(value, 12);
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < actualBytes.byteLength; i++) {
    diff |= actualBytes[i] ^ expectedBytes[i];
  }
  return diff === 0;
}
