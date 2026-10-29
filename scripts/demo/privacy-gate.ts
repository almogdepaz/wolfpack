#!/usr/bin/env bun
/**
 * Privacy gate for demo media and site text. Forbidden strings are computed at
 * run time from this machine (hostname, pretty name, username, home directory,
 * network interface addresses, Tailscale DNS names/IPs when the CLI answers)
 * plus `--forbid a,b`, so nothing private is ever written into the repository
 * to be checked against. Text is also scanned for credential-shaped strings
 * (JWTs, GitHub/Tailscale/cloud tokens, private keys).
 *
 *   bun scripts/demo/privacy-gate.ts [--forbid a,b] <file-or-dir>...
 *
 * Exits 1 on any hit, printing the file and a masked form of the string.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { extname, join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");

/** Strings shorter than this are too ambiguous to forbid (false positives in prose). */
const MIN_FORBIDDEN_LENGTH = 3;
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".vtt", ".json", ".txt", ".md", ".css", ".js", ".ts", ".ans", ".svg", ".xml", ".srt", ".ass"]);

/**
 * Account names that are shared by convention (containers, CI images); as a
 * bare word they would match ordinary text such as "node:fs". The home
 * directory is still forbidden for these accounts.
 */
const GENERIC_ACCOUNT_NAMES = new Set(["root", "node", "runner", "user", "admin", "ubuntu", "debian", "app", "docker", "ci", "build"]);

/** Credential shapes that must never appear in committed text or recorded pages. */
export const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "Tailscale key", pattern: /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/ },
  { name: "API secret key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export interface PrivacyHit {
  readonly where: string;
  readonly masked: string;
}

export class PrivacyViolation extends Error {
  constructor(readonly hits: readonly PrivacyHit[]) {
    super(`privacy gate: ${hits.map((hit) => `${hit.where} contains ${hit.masked}`).join("; ")}`);
  }
}

export function mask(value: string): string {
  return `${value.slice(0, 1)}${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-1)} (${value.length} chars)`;
}

function commandOutput(file: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function tailscaleIdentity(): string[] {
  const raw = commandOutput("tailscale", ["status", "--json", "--self=true", "--peers=false"]);
  if (!raw) return [];
  try {
    const status = JSON.parse(raw) as { Self?: { DNSName?: string; HostName?: string; TailscaleIPs?: string[] }; MagicDNSSuffix?: string };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    return [dnsName, status.Self?.HostName, status.MagicDNSSuffix, ...(status.Self?.TailscaleIPs ?? [])]
      .filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

/** Non-loopback addresses of this machine's network interfaces (IPv4, IPv6, MAC). */
export function interfaceAddresses(interfaces = networkInterfaces()): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      addresses.push(entry.address.split("%")[0]!);
      if (entry.mac && entry.mac !== "00:00:00:00:00:00") addresses.push(entry.mac);
    }
  }
  return addresses;
}

/** This machine's identifying strings plus any extra ones; de-duplicated, longest first. */
export function forbiddenStrings(extra: readonly string[] = [], options: { readonly probeSystem?: boolean } = {}): string[] {
  const username = userInfo().username;
  const system = options.probeSystem === false ? [] : [
    hostname(),
    hostname().split(".")[0],
    commandOutput("hostnamectl", ["--pretty"])?.trim(),
    GENERIC_ACCOUNT_NAMES.has(username.toLowerCase()) ? undefined : username,
    homedir(),
    ...interfaceAddresses(),
    ...tailscaleIdentity(),
  ];
  const values = [...system, ...extra]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value && value.length >= MIN_FORBIDDEN_LENGTH);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/**
 * Public identifiers that may legitimately contain a forbidden substring: the
 * GitHub owner in the project's published URLs (package.json homepage/bugs).
 */
export function publicAllowlist(packageJsonPath = join(REPOSITORY_ROOT, "package.json")): string[] {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { homepage?: string; bugs?: { url?: string } };
  const owners = new Set<string>();
  for (const url of [manifest.homepage, manifest.bugs?.url]) {
    if (!url) continue;
    const parsed = new URL(url);
    const pagesOwner = /^([a-z0-9-]+)\.github\.io$/i.exec(parsed.hostname)?.[1];
    const repoOwner = parsed.hostname === "github.com" ? parsed.pathname.split("/")[1] : undefined;
    for (const owner of [pagesOwner, repoOwner]) if (owner) owners.add(owner);
  }
  return [...owners];
}

/**
 * Forbidden strings (case-insensitive, outside the allowlist) plus every
 * credential-shaped match, so one call covers both leak classes.
 */
export function findForbidden(text: string, forbidden: readonly string[], allowed: readonly string[] = []): string[] {
  let haystack = text.toLowerCase();
  for (const value of allowed) haystack = haystack.split(value.toLowerCase()).join(" ");
  return [...forbidden.filter((value) => haystack.includes(value.toLowerCase())), ...findSecrets(text)];
}

/** Credential-shaped substrings of `text`, labelled by kind. */
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const { pattern } of SECRET_PATTERNS) {
    const match = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (const found of text.matchAll(match)) hits.push(found[0]);
  }
  return hits;
}

/** Throws PrivacyViolation when `text` contains any forbidden string outside the public allowlist. */
export function assertClean(text: string, where: string, forbidden: readonly string[], allowed: readonly string[] = publicAllowlist()): void {
  const hits = findForbidden(text, forbidden, allowed);
  if (hits.length > 0) throw new PrivacyViolation(hits.map((value) => ({ where, masked: mask(value) })));
}

function textFiles(path: string): string[] {
  if (!existsSync(path)) throw new Error(`privacy gate: no such path ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .map((name) => join(path, name))
    .filter((file) => statSync(file).isFile() && TEXT_EXTENSIONS.has(extname(file).toLowerCase()));
}

/** Scans text files under `paths`; returns every hit instead of stopping at the first. */
export function scanPaths(
  paths: readonly string[],
  forbidden: readonly string[],
  allowed: readonly string[] = publicAllowlist(),
): { readonly scanned: number; readonly hits: PrivacyHit[] } {
  const hits: PrivacyHit[] = [];
  let scanned = 0;
  for (const file of paths.flatMap(textFiles)) {
    scanned += 1;
    for (const value of findForbidden(readFileSync(file, "utf8"), forbidden, allowed)) hits.push({ where: file, masked: mask(value) });
  }
  return { scanned, hits };
}

export function parseForbidList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const forbidIndex = args.indexOf("--forbid");
  const extra = forbidIndex >= 0 ? parseForbidList(args[forbidIndex + 1]) : [];
  const paths = args.filter((_arg, index) => forbidIndex < 0 || (index !== forbidIndex && index !== forbidIndex + 1));
  if (paths.length === 0) {
    console.error("usage: bun scripts/demo/privacy-gate.ts [--forbid a,b] <file-or-dir>...");
    process.exit(2);
  }
  const forbidden = forbiddenStrings(extra);
  const { scanned, hits } = scanPaths(paths, forbidden);
  for (const hit of hits) console.error(`privacy gate: ${hit.where} contains ${hit.masked}`);
  console.log(`privacy gate: ${hits.length === 0 ? "ok" : "FAILED"} (${scanned} files, ${forbidden.length} forbidden strings)`);
  process.exit(hits.length === 0 ? 0 : 1);
}
