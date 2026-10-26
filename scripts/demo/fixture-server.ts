#!/usr/bin/env bun
/**
 * Demo fixture server: the real Wolfpack server (HTTP routes, websocket relay,
 * session observation) on a random loopback port, backed by MockBackend with
 * the synthetic sessions from `fixtures/sessions.json`. Modelled on
 * `tests/e2e/test-server.ts`: isolated temporary HOME, WOLFPACK_TEST=1, no
 * Tailnet probing, and the machine display name replaced by the fixture's
 * label so the real hostname never reaches the page.
 *
 *   bun scripts/demo/fixture-server.ts [--machine workstation|macbook]
 *
 * Prints `READY:<port>` when listening. Control is JSON lines on stdin:
 *   {"play":"<session>","transcript":"<file>.ans","id":"<id>"}  → prints DONE:<id> when finished
 *   {"emit":"<session>","text":"..."}
 *   {"status":"<session>","record":{"state":"blocked",...}|null}
 * Typed terminal input that matches a session's `reactions` plays that reaction.
 * Exits when stdin closes or on SIGTERM.
 */
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  assertOwnedTestServerHome,
  createOwnedTestServerHome,
  removeOwnedTestServerHome,
  type OwnedTestServerHome,
} from "../../tests/e2e/test-server-home";
import {
  loadFixtures,
  parseStatus,
  readTranscript,
  renderInstantly,
  type DemoStatus,
  type TranscriptStep,
} from "./fixtures";

const ISOLATED_HOME_ARG = "--isolated-demo-home";
const BOOTSTRAP_ARG = "--bootstrap-owned-demo-home";
/** Keep the replayable screen bounded, like a terminal scrollback. */
const SCREEN_LINE_LIMIT = 400;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const machineId = argValue("--machine") ?? "workstation";

async function runOwnedBootstrap(home: OwnedTestServerHome): Promise<never> {
  assertOwnedTestServerHome(home);
  const child = Bun.spawn([process.execPath, import.meta.path, ISOLATED_HOME_ARG, home.path, "--machine", machineId], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home.path },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  let exitCode = 1;
  try {
    exitCode = await child.exited;
  } finally {
    removeOwnedTestServerHome(home);
  }
  process.exit(exitCode);
}

// Bun resolves os.homedir() at startup; re-exec so every module sees the temp HOME.
const bootstrapIndex = process.argv.indexOf(BOOTSTRAP_ARG);
if (bootstrapIndex >= 0) {
  await runOwnedBootstrap({ path: process.argv[bootstrapIndex + 1] ?? "", token: process.argv[bootstrapIndex + 2] ?? "" });
}
const isolatedHome = argValue(ISOLATED_HOME_ARG);
if (!isolatedHome) await runOwnedBootstrap(createOwnedTestServerHome());

const fixtures = loadFixtures();
const machine = fixtures.machines[machineId];
if (!machine) throw new Error(`unknown --machine ${machineId}; known: ${Object.keys(fixtures.machines).join(", ")}`);
const clockMs = Date.parse(fixtures.clock);

process.env.HOME = isolatedHome;
process.env.WOLFPACK_TEST = "1";
const installationIdPath = join(isolatedHome!, "demo-installation-id");
writeFileSync(installationIdPath, `${machine.installationId}\n`);
process.env.WOLFPACK_MACHINE_ID_PATH = installationIdPath;
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { ID: machine.tailnetNodeId, HostName: machine.host.split(".")[0], DNSName: `${machine.host}.` },
  Peer: {},
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exit(0);
};
process.once("SIGTERM", shutdown);

const { mock: bunMock } = await import("bun:test");
const realHttp = await import("../../src/server/http.ts");
await bunMock.module("../../src/server/http.js", () => ({
  ...realHttp,
  // Peers are supplied by the recorder in the browser; never probe a real tailnet.
  enumerateLocalTailnetCandidates: async () => ({ candidates: [] }),
}));
const realDisplayName = await import("../../src/machine-display-name.ts");
await bunMock.module("../../src/machine-display-name.js", () => ({
  ...realDisplayName,
  getMachineDisplayName: () => machine.label,
}));

const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
type PublicSessionIdentity = import("../../src/server/session-identity.ts").PublicSessionIdentity;
type SessionPrefillOptions = import("../../src/server/backend.ts").SessionPrefillOptions;

const sessions = fixtures.sessions.filter((session) => session.machine === machineId);

/** Deterministic UUID (version 4 layout) for a MockBackend id on this machine. */
function demoSessionId(mockId: string): string {
  const hex = createHash("sha256").update(`${machineId}/${mockId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** MockBackend with ANSI screens, fixture timestamps and scripted reactions to typed input. */
class DemoBackend extends MockBackend {
  private readonly screens = new Map<string, string>();
  private readonly typed = new Map<string, string>();
  private readonly createdAt = new Map<string, string>();

  screen(name: string): string {
    return this.screens.get(name) ?? "";
  }

  appendScreen(name: string, text: string): void {
    const lines = (this.screen(name) + text).split("\n");
    this.screens.set(name, lines.slice(-SCREEN_LINE_LIMIT).join("\n"));
  }

  setCreatedAt(name: string, iso: string): void {
    this.createdAt.set(name, iso);
  }

  /**
   * Real broker session ids are UUIDs and the app relies on that (extension
   * scope, snapshots), so MockBackend's `mock:<name>` ids are mapped to stable
   * UUIDs derived from machine and name; parent links are mapped the same way.
   */
  override async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    const identities = await super.listIdentities();
    for (const [name, identity] of Object.entries(identities)) {
      const createdAt = this.createdAt.get(name);
      const parent = identity.parentSession;
      identities[name] = {
        ...identity,
        wolfpackSessionId: demoSessionId(identity.wolfpackSessionId),
        ...(createdAt && { createdAt, updatedAt: createdAt }),
        ...(parent && { parentSession: { ...parent, wolfpackSessionId: demoSessionId(parent.wolfpackSessionId) } }),
      };
    }
    return identities;
  }

  /** The real broker sends an ANSI snapshot; keep colour instead of MockBackend's stripped text. */
  override async getSessionPrefill(name: string, cols?: number, options?: SessionPrefillOptions): Promise<{ data: Buffer; seq?: bigint }> {
    const plain = await super.getSessionPrefill(name, cols, options);
    let ansi = this.screen(name);
    if (options?.maxBytes !== undefined) {
      const lines = ansi.split("\n");
      while (lines.length > 1 && Buffer.byteLength(lines.join("\n")) > options.maxBytes) lines.shift();
      ansi = lines.join("\n");
    }
    return { data: Buffer.from(ansi), seq: plain.seq };
  }

  override writeToTerminal(name: string, data: Buffer | string): boolean {
    const session = sessions.find((candidate) => candidate.name === name);
    const typed = ((this.typed.get(name) ?? "") + data.toString()).slice(-64);
    this.typed.set(name, typed);
    for (const [input, reaction] of Object.entries(session?.reactions ?? {})) {
      if (!typed.endsWith(input)) continue;
      this.typed.set(name, "");
      if (reaction.status !== undefined) applyStatus(name, reaction.status);
      void (async () => {
        if (reaction.play) await play(name, readTranscript(reaction.play));
        for (const child of reaction.spawn ?? []) await createFixtureSession(child);
      })();
      break;
    }
    return true;
  }
}

const backend: DemoBackend = new DemoBackend({
  sessions: [],
  capturePane: async (name: string): Promise<string> => backend.screen(name),
});

function applyStatus(name: string, status: DemoStatus | null): void {
  backend.setProgramStatus(name, status === null ? undefined : { id: "", ...status, updatedAtMs: Date.now() });
}

function emit(name: string, text: string): void {
  backend.appendScreen(name, text);
  backend.emitSessionData(name, text);
}

async function play(name: string, steps: readonly TranscriptStep[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === "emit") emit(name, step.text);
    else if (step.kind === "status") applyStatus(name, step.status);
    else if (step.kind === "pause") await Bun.sleep(step.ms);
    else {
      for (const character of Array.from(step.text)) {
        emit(name, character);
        await Bun.sleep(step.msPerChar);
      }
    }
  }
}

const loadSettings = () => ({ agentCmd: "claude" });
async function createFixtureSession(name: string): Promise<void> {
  const session = sessions.find((candidate) => candidate.name === name);
  if (!session) throw new Error(`unknown fixture session ${name}`);
  const parent = session.parent;
  backend.setCreatedAt(session.name, new Date(clockMs - session.createdMinutesAgo * 60_000).toISOString());
  const initial = renderInstantly(readTranscript(session.screen));
  backend.appendScreen(session.name, initial.text);
  if (initial.status) applyStatus(session.name, initial.status);
  await backend.createSession(session.name, `/workspace/${session.project}`, undefined, loadSettings, {
    agentKind: session.harness,
    ...(parent && { parentSession: { wolfpackSessionId: `mock:${parent}`, wolfpackSessionName: parent } }),
  });
}
for (const session of sessions) {
  if (!session.deferred) await createFixtureSession(session.name);
}
__setTestBackend(backend);

const { server } = await import("../../src/server/index.ts");

function requireSession(name: unknown): string {
  if (typeof name !== "string" || !sessions.some((session) => session.name === name)) throw new Error(`unknown session ${String(name)}`);
  return name;
}

const control = createInterface({ input: process.stdin });
control.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const command = JSON.parse(line) as Record<string, unknown>;
    if ("play" in command) {
      const name = requireSession(command.play);
      const id = String(command.id ?? command.transcript);
      void play(name, readTranscript(String(command.transcript))).then(() => console.log(`DONE:${id}`));
    } else if ("emit" in command) {
      emit(requireSession(command.emit), String(command.text ?? ""));
    } else if ("status" in command) {
      applyStatus(requireSession(command.status), parseStatus(command.record ?? null, "status command"));
    } else {
      throw new Error("expected play, emit or status");
    }
  } catch (error) {
    console.log(`ERROR:${error instanceof Error ? error.message : String(error)}`);
  }
});
control.once("close", shutdown);

server.listen(0, "127.0.0.1", () => {
  console.log(`READY:${(server.address() as AddressInfo).port}`);
});
