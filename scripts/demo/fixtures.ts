/**
 * Demo fixture model shared by the fixture server, the recorder and tests:
 * the `sessions.json` schema and the `.ans` transcript format.
 *
 * Transcript format (one directive or content line per line):
 *   @+<ms>                 pause before the next step
 *   @status <json|null>    set the session's program status (OSC 7501 shape: state, kind, title, message)
 *   @type <ms> <text>      type <text> one character at a time, <ms> apart (no trailing newline)
 *   @# <comment>           ignored
 *   @@<text>               literal content line starting with "@"
 *   anything else          content; emitted with CRLF unless it ends in `\c`
 * Content escapes: `\e` = ESC, `\\` = backslash, `\c` (at line end) = no newline.
 * Style tags: {bold} {dim} {italic} {inverse} {red} {green} {yellow} {blue} {magenta} {cyan}
 * {gray} {white} {orange} {accent} {/} (reset). Unknown `{...}` text is left alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEMO_DIR = import.meta.dirname;
export const FIXTURES_DIR = join(DEMO_DIR, "fixtures");
export const TRANSCRIPTS_DIR = join(FIXTURES_DIR, "transcripts");

export const PROGRAM_STATES = ["idle", "working", "done", "blocked", "error"] as const;
export const PROGRAM_KINDS = ["permission", "question", "auth"] as const;
export const HARNESSES = ["claude", "codex", "gemini", "cursor", "pi", "custom"] as const;

export interface DemoStatus {
  readonly state: typeof PROGRAM_STATES[number];
  readonly kind?: typeof PROGRAM_KINDS[number];
  readonly title?: string;
  readonly message?: string;
}

export interface DemoReaction {
  /** Transcript to play when the input arrives. */
  readonly play?: string;
  /** Status to apply before playing (null clears the program status). */
  readonly status?: DemoStatus | null;
  /** Deferred child sessions (`spawnedByReaction`) created after the transcript plays. */
  readonly spawn?: readonly string[];
}

export interface DemoMachine {
  /** Display name the app shows for the machine (e.g. Workstation). */
  readonly label: string;
  /** Fictional tailnet host, always under example.ts.net. */
  readonly host: string;
  readonly tailnetNodeId: string;
  readonly installationId: string;
}

export interface DemoSession {
  readonly name: string;
  readonly machine: string;
  readonly harness: typeof HARNESSES[number];
  readonly project: string;
  /** Parent session name on the same machine (delegation tree). */
  readonly parent?: string;
  /** Transcript rendered instantly at startup as the session's existing screen. */
  readonly screen: string;
  /** Minutes before the fixture clock that the session was created. */
  readonly createdMinutesAgo: number;
  /** Not created at startup; a parent's reaction `spawn`s it later. */
  readonly deferred?: boolean;
  /** Input → reaction, matched against the end of the session's typed input. */
  readonly reactions?: Readonly<Record<string, DemoReaction>>;
}

export interface DemoFixtures {
  /** Fixed wall clock for stills and recordings (ISO-8601). */
  readonly clock: string;
  readonly machines: Readonly<Record<string, DemoMachine>>;
  readonly sessions: readonly DemoSession[];
}

export type TranscriptStep =
  | { readonly kind: "emit"; readonly text: string }
  | { readonly kind: "pause"; readonly ms: number }
  | { readonly kind: "type"; readonly text: string; readonly msPerChar: number }
  | { readonly kind: "status"; readonly status: DemoStatus | null };

const ESC = "\x1b";
const STYLE_TAGS: Readonly<Record<string, string>> = {
  "/": `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  inverse: `${ESC}[7m`,
  red: `${ESC}[38;2;255;138;128m`,
  green: `${ESC}[38;2;69;237;126m`,
  yellow: `${ESC}[38;2;246;195;92m`,
  blue: `${ESC}[38;2;122;162;247m`,
  magenta: `${ESC}[38;2;198;160;246m`,
  cyan: `${ESC}[38;2;125;207;255m`,
  gray: `${ESC}[38;2;128;135;130m`,
  white: `${ESC}[38;2;232;236;233m`,
  orange: `${ESC}[38;2;217;119;87m`,
  accent: `${ESC}[38;2;69;237;126m`,
};

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function decodeContent(line: string, context: string): string {
  let newline = "\r\n";
  let body = line;
  if (body.endsWith("\\c")) {
    newline = "";
    body = body.slice(0, -2);
  }
  const unescaped = body.replace(/\\(e|\\)/g, (_match, code: string) => (code === "e" ? ESC : "\\"));
  if (/\\[^e\\]/.test(body.replace(/\\\\/g, ""))) fail(context, `unknown escape in ${JSON.stringify(line)}`);
  const styled = unescaped.replace(/\{([a-z/]+)\}/g, (match, tag: string) => STYLE_TAGS[tag] ?? match);
  return styled + newline;
}

export function parseStatus(raw: unknown, context: string): DemoStatus | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail(context, "status must be an object or null");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["state", "kind", "title", "message"].includes(key)) fail(context, `unknown status field ${key}`);
  }
  if (!PROGRAM_STATES.includes(record.state as DemoStatus["state"])) fail(context, `invalid status state ${String(record.state)}`);
  if (record.kind !== undefined && !PROGRAM_KINDS.includes(record.kind as NonNullable<DemoStatus["kind"]>)) {
    fail(context, `invalid status kind ${String(record.kind)}`);
  }
  for (const key of ["title", "message"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") fail(context, `status ${key} must be a string`);
  }
  return record as unknown as DemoStatus;
}

export function parseTranscript(source: string, name = "transcript"): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let pending = "";
  const flush = (): void => {
    if (pending) steps.push({ kind: "emit", text: pending });
    pending = "";
  };
  lines.forEach((line, index) => {
    const context = `${name}:${index + 1}`;
    if (line.startsWith("@@")) {
      pending += decodeContent(line.slice(1), context);
      return;
    }
    if (!line.startsWith("@")) {
      pending += decodeContent(line, context);
      return;
    }
    flush();
    const pause = /^@\+(\d+)$/.exec(line);
    if (pause) {
      steps.push({ kind: "pause", ms: Number(pause[1]) });
    } else if (line.startsWith("@status ")) {
      let raw: unknown;
      try {
        raw = JSON.parse(line.slice("@status ".length));
      } catch {
        fail(context, "status is not valid JSON");
      }
      steps.push({ kind: "status", status: parseStatus(raw, context) });
    } else if (line.startsWith("@type ")) {
      const typed = /^@type (\d+) (.+)$/.exec(line) ?? fail(context, "expected @type <ms> <text>");
      steps.push({ kind: "type", msPerChar: Number(typed[1]), text: decodeContent(`${typed[2]}\\c`, context) });
    } else if (!line.startsWith("@# ") && line !== "@#") {
      fail(context, `unknown directive ${JSON.stringify(line)}`);
    }
  });
  flush();
  return steps;
}

export function transcriptDurationMs(steps: readonly TranscriptStep[]): number {
  return steps.reduce((total, step) => {
    if (step.kind === "pause") return total + step.ms;
    if (step.kind === "type") return total + step.msPerChar * Array.from(step.text).length;
    return total;
  }, 0);
}

/** Everything a transcript prints, as if it had already finished, plus its final status. */
export function renderInstantly(steps: readonly TranscriptStep[]): { readonly text: string; readonly status: DemoStatus | null | undefined } {
  let text = "";
  let status: DemoStatus | null | undefined;
  for (const step of steps) {
    if (step.kind === "emit" || step.kind === "type") text += step.text;
    if (step.kind === "status") status = step.status;
  }
  return { text, status };
}

export function readTranscript(file: string): TranscriptStep[] {
  return parseTranscript(readFileSync(join(TRANSCRIPTS_DIR, file), "utf8"), file);
}

const SESSION_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FICTIONAL_HOST = /^[a-z0-9-]+\.example\.ts\.net$/;

export function validateFixtures(raw: unknown, transcriptExists: (file: string) => boolean = () => true): DemoFixtures {
  if (typeof raw !== "object" || raw === null) fail("sessions.json", "must be an object");
  const fixtures = raw as DemoFixtures;
  if (typeof fixtures.clock !== "string" || Number.isNaN(Date.parse(fixtures.clock))) fail("sessions.json", "clock must be an ISO date");
  const machineIds = Object.keys(fixtures.machines ?? {});
  if (machineIds.length === 0) fail("sessions.json", "needs at least one machine");
  for (const id of machineIds) {
    const machine = fixtures.machines[id]!;
    if (!/^[A-Za-z][A-Za-z0-9 -]{1,31}$/.test(machine.label ?? "")) fail(`machine ${id}`, "label must be a plain display name");
    if (!FICTIONAL_HOST.test(machine.host ?? "")) fail(`machine ${id}`, "host must be a fictional *.example.ts.net name");
    if (!/^n-[a-z0-9-]+$/.test(machine.tailnetNodeId ?? "")) fail(`machine ${id}`, "tailnetNodeId must look like n-<name>");
    if (!/^[0-9a-f-]{36}$/.test(machine.installationId ?? "")) fail(`machine ${id}`, "installationId must be a UUID");
  }
  const names = new Set<string>();
  for (const session of fixtures.sessions ?? []) {
    const context = `session ${session.name}`;
    if (!SESSION_NAME.test(session.name ?? "")) fail(context, "invalid name");
    const key = `${session.machine}/${session.name}`;
    if (names.has(key)) fail(context, "duplicate on its machine");
    names.add(key);
    if (!machineIds.includes(session.machine)) fail(context, `unknown machine ${session.machine}`);
    if (!HARNESSES.includes(session.harness)) fail(context, `unknown harness ${session.harness}`);
    if (!SESSION_NAME.test(session.project ?? "")) fail(context, "project must be a plain fictional name");
    if (typeof session.createdMinutesAgo !== "number" || session.createdMinutesAgo < 0) fail(context, "createdMinutesAgo must be >= 0");
    if (!transcriptExists(session.screen)) fail(context, `missing screen transcript ${session.screen}`);
    for (const [input, reaction] of Object.entries(session.reactions ?? {})) {
      if (!input) fail(context, "empty reaction input");
      if (reaction.play !== undefined && !transcriptExists(reaction.play)) fail(context, `missing reaction transcript ${reaction.play}`);
      if (reaction.status !== undefined) parseStatus(reaction.status, `${context} reaction ${JSON.stringify(input)}`);
    }
  }
  for (const session of fixtures.sessions) {
    for (const reaction of Object.values(session.reactions ?? {})) {
      for (const child of reaction.spawn ?? []) {
        const target = fixtures.sessions.find((candidate) => candidate.name === child && candidate.machine === session.machine);
        if (!target?.deferred || target.parent !== session.name) {
          fail(`session ${session.name}`, `spawn target ${child} must be a deferred child of ${session.name}`);
        }
      }
    }
  }
  for (const session of fixtures.sessions) {
    if (session.parent === undefined) continue;
    if (!names.has(`${session.machine}/${session.parent}`)) fail(`session ${session.name}`, `parent ${session.parent} is not on ${session.machine}`);
  }
  return fixtures;
}

export function loadFixtures(path = join(FIXTURES_DIR, "sessions.json")): DemoFixtures {
  return validateFixtures(JSON.parse(readFileSync(path, "utf8")), (file) => existsSync(join(TRANSCRIPTS_DIR, file)));
}
