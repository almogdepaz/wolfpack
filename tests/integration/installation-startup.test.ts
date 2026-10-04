import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { accessSync, constants, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { request } from "node:http";
import { BrokerClient } from "../../src/broker/client.js";

const repository = process.cwd();
const brokerBinary = join(repository, "broker/target/release/wolfpack-broker");
// Short paths are required for macOS Unix sockets. Retain receipts separately.
const suite = mkdtempSync("/tmp/wp-installation-");
const evidence = mkdtempSync("/tmp/wp-installation-evidence-");
const compiled = join(suite, "package", "wolfpack");
const runner = join(suite, "launcher", "bin", "run.cjs");
const children: ChildProcess[] = [];
const ptys = new Set<number>();
let cleanupFailed = false;
let sequence = 0;

interface Fixture {
  readonly home: string;
  readonly port: number;
  readonly socketPath: string;
  readonly env: NodeJS.ProcessEnv;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

function fixture(): Fixture {
  const home = mkdtempSync(join(suite, "home-"));
  const state = join(home, ".wolfpack");
  const bin = join(home, "commands");
  for (const path of [join(state, "bin"), bin, join(home, "Dev"), join(home, "tmp")]) mkdirSync(path, { recursive: true });
  copyFileSync(brokerBinary, join(state, "bin", "wolfpack-broker"));
  chmodSync(join(state, "bin", "wolfpack-broker"), 0o755);
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  writeFileSync(join(state, "config.json"), JSON.stringify({ devDir: join(home, "Dev"), port }));
  writeFileSync(join(home, "manager.log"), "");
  for (const name of ["launchctl", "systemctl", "loginctl", "sudo", "brew", "apt", "apt-get", "open", "service", "rc-service", "rc-update", "cargo", "zig", "which", "lsof", "ss", "ps", "pgrep", "pkill", "killall", "claude", "codex", "pi", "opencode"]) {
    executable(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${home}/manager.log'\nexit 97\n`);
  }
  // Positive discovery prevents the absolute macOS Tailscale fallback.
  executable(join(bin, "tailscale"), '#!/bin/sh\ncase "$1" in version) exit 0 ;; status) printf \'{"BackendState":"NeedsLogin"}\\n\'; exit 0 ;; *) exit 97 ;; esac\n');
  symlinkSync("/bin/test", join(bin, "test"));
  symlinkSync("/usr/bin/curl", join(bin, "curl"));
  const shell = join(bin, "fixture-shell");
  executable(shell, `#!/bin/sh\nprintf '%s\\n' "$PATH" >> '${home}/shell-paths.log'\nif [ "$1" = "-lic" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n`);
  const socketPath = join(state, "wolfpack-broker.sock");
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: bin, USER: "wolfpack_test", SHELL: shell, TERM: "dumb", LANG: "C", NO_COLOR: "1",
    TMPDIR: join(home, "tmp"), XDG_RUNTIME_DIR: state,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    WOLFPACK_BROKER_SOCKET: socketPath, WOLFPACK_TASK_ROOT: join(home, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home, "relay"),
  };
  return { home, port, socketPath, env };
}

function launch(args: readonly string[], f: Fixture, name: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const fd = openSync(join(f.home, `${name}.log`), "a", 0o600);
  try {
    const child = spawn(args[0]!, args.slice(1), { cwd: f.home, env: { ...f.env, ...extra }, detached: true, stdio: ["ignore", fd, fd] });
    children.push(child);
    writeFileSync(join(evidence, `launch-${sequence++}.json`), JSON.stringify({ pid: child.pid, args, home: f.home, log: name, detached: true }), { mode: 0o600 });
    return child;
  } finally { closeSync(fd); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function signal(pid: number, value: NodeJS.Signals): void {
  try { process.kill(pid, value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function until(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(25);
  return check();
}
function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
async function stop(child: ChildProcess, group = false): Promise<void> {
  if (!exited(child)) {
    if (group) signal(-child.pid!, "SIGINT"); else child.kill("SIGTERM");
    if (!await until(() => exited(child))) throw new Error("owned child did not shut down cooperatively");
  }
}

function health(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/api/health", agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
    });
    req.setTimeout(500, () => req.destroy(new Error("health observation timeout")));
    req.once("error", reject);
    req.end();
  });
}
async function ready(f: Fixture, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 12000;
  while (!exited(child) && Date.now() < deadline) {
    try {
      const observed = await health(f.port);
      if (typeof observed === "object" && observed !== null && "status" in observed && observed.status === "ready") return true;
    } catch { /* listener has not bound yet */ }
    await Bun.sleep(50);
  }
  if (!exited(child)) throw new Error("live fixture exceeded readiness observation deadline");
  return false;
}
async function brokerClient(socketPath: string): Promise<BrokerClient | undefined> {
  const client = new BrokerClient({ socketPath });
  client.start();
  if (!await until(() => client.isConnected(), 500)) { client.close(); return undefined; }
  return client;
}
async function brokerReady(f: Fixture): Promise<boolean> {
  const client = await brokerClient(f.socketPath);
  if (!client) return false;
  try { return (await client.request("list_sessions", {}, { timeoutMs: 1000 })).status === "ok"; }
  finally { client.close(); }
}
async function createPty(f: Fixture): Promise<number> {
  const client = await brokerClient(f.socketPath);
  if (!client) throw new Error("PTY prerequisite broker unavailable");
  try {
    const response = await client.request("create_session", { name: "owned-pty", cwd: f.home, command: ["/bin/sleep", "60"], env: [], cols: 80, rows: 24 });
    if (response.status !== "ok") throw new Error("real PTY creation failed");
    const session = response.payload?.session as { pid: number };
    if (!Number.isSafeInteger(session.pid) || session.pid <= 1) throw new Error("invalid owned PTY PID");
    ptys.add(session.pid);
    return session.pid;
  } finally { client.close(); }
}
function receipt(f: Fixture, observations: unknown): void {
  const target = join(evidence, `${sequence++}`);
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "observations.json"), JSON.stringify(observations), { mode: 0o600 });
  const setupReceipt = join(f.home, "setup-receipt.json");
  if (existsSync(setupReceipt)) copyFileSync(setupReceipt, join(target, "setup-receipt.json"));
  for (const name of ["foreground", "independent", "manager", "shell-paths", "setup", "managed"]) {
    const path = join(f.home, `${name}.log`);
    if (existsSync(path)) { copyFileSync(path, join(target, `${name}.log`)); chmodSync(join(target, `${name}.log`), 0o600); }
  }
}
function assertIsolation(f: Fixture): void {
  const paths = readFileSync(join(f.home, "shell-paths.log"), "utf8").trim().split("\n");
  expect(paths.every(path => path === f.env.PATH)).toBe(true);
  expect(readFileSync(join(f.home, "manager.log"), "utf8")).toBe("");
}
function assertNoDescriptors(f: Fixture): void {
  for (const path of ["Library/LaunchAgents/com.wolfpack.server.plist", "Library/LaunchAgents/com.wolfpack.broker.plist", ".config/systemd/user/wolfpack.service", ".config/systemd/user/wolfpack-broker.service", ".wolfpack/service-auth.json"]) expect(existsSync(join(f.home, path))).toBe(false);
}

beforeAll(() => {
  for (const path of [process.execPath, brokerBinary, "/bin/sh", "/bin/test", "/usr/bin/python3", "/usr/bin/curl"]) accessSync(path, constants.X_OK);
  mkdirSync(join(suite, "package"));
  const f = fixture();
  const built = spawnSync(process.execPath, ["build", "--compile", "--entry-naming", "[name].js", "src/cli/index.ts", "src/task-relay/worker-entry.ts", "--outfile", compiled], { cwd: repository, env: f.env, encoding: "utf8", timeout: 25000 });
  receipt(f, { build: { status: built.status, error: built.error?.message, stdout: built.stdout, stderr: built.stderr } });
  expect(built.status, built.stderr).toBe(0);
  copyFileSync(brokerBinary, join(suite, "package", "wolfpack-broker"));
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  const name = `wolfpack-bridge-${process.platform}-${process.arch}`;
  writeFileSync(join(suite, "package", "package.json"), JSON.stringify({ name, version: manifest.version }));
  mkdirSync(join(suite, "launcher", "bin"), { recursive: true });
  mkdirSync(join(suite, "launcher", "node_modules"));
  copyFileSync(join(repository, "bin/run.cjs"), runner);
  writeFileSync(join(suite, "launcher", "package.json"), JSON.stringify({ version: manifest.version, optionalDependencies: { [name]: manifest.version } }));
  symlinkSync(join(suite, "package"), join(suite, "launcher", "node_modules", name));
}, 30000);

afterEach(async () => {
  const roots = children.splice(0).map(child => ({ child, pid: child.pid }));
  // Persist exact ownership before signals, assertions, or a failed probe.
  writeFileSync(join(evidence, `cleanup-input-${sequence++}.json`), JSON.stringify({ roots: roots.map(({ child, pid }) => ({ pid, exitCode: child.exitCode, signalCode: child.signalCode })), ptys: [...ptys] }), { mode: 0o600 });
  const outcomes = await Promise.allSettled(roots.map(async ({ child, pid }) => {
    if (!pid) return;
    signal(-pid, "SIGTERM");
    // Darwin can return EPERM for a terminating, unreaped group leader.
    // Reap the root first; EPERM never constitutes group-absence evidence.
    if (!await until(() => exited(child), 3000)) signal(-pid, "SIGKILL");
    if (!await until(() => exited(child), 3000)) throw new Error(`owned root ${pid} not reaped`);
    if (!await until(() => !alive(-pid), 3000)) signal(-pid, "SIGKILL");
    if (!await until(() => !alive(-pid), 3000)) throw new Error(`owned group ${pid} survives cleanup`);
  }));
  for (const pid of ptys) {
    if (alive(pid)) signal(pid, "SIGTERM");
    if (!await until(() => !alive(pid), 1000)) signal(pid, "SIGKILL");
    if (!await until(() => !alive(pid), 2000)) { cleanupFailed = true; throw new Error(`owned PTY ${pid} survives cleanup`); }
  }
  ptys.clear();
  writeFileSync(join(evidence, `cleanup-${sequence++}.json`), JSON.stringify(outcomes.map((outcome, index) => outcome.status === "fulfilled" ? { pid: roots[index]?.pid, status: outcome.status } : { pid: roots[index]?.pid, status: outcome.status, code: (outcome.reason as NodeJS.ErrnoException).code, error: String(outcome.reason) })), { mode: 0o600 });
  for (const outcome of outcomes) if (outcome.status === "rejected") { cleanupFailed = true; throw outcome.reason; }
}, 15000);
afterAll(() => {
  if (!cleanupFailed) rmSync(suite, { recursive: true, force: true });
  console.info(`installation receipts: ${evidence}${cleanupFailed ? `; cleanup failed, retained ${suite}` : ""}`);
});

for (const entry of ["source", "package"] as const) {
  test(`${entry}: decline login services then ordinary start serves without descriptors`, async () => {
    const f = fixture();
    rmSync(join(f.env.PATH!, "curl")); // declined setup and foreground need no curl
    rmSync(join(f.home, ".wolfpack", "config.json"));
    const args = entry === "source" ? [process.execPath, join(repository, "src/cli/index.ts")] : [process.execPath, runner];
    const setup = spawnSync("/usr/bin/python3", ["-I", "-S", "-B", join(repository, "tests/fixtures/installation-setup-pty.py"), ...args, "setup"], { cwd: f.home, env: f.env, input: `\n${f.port}\nskip\nn\nn\n`, encoding: "utf8", timeout: 20000 });
    writeFileSync(join(f.home, "setup.log"), setup.stdout + setup.stderr);
    receipt(f, { setupStatus: setup.status, error: setup.error?.message });
    expect(setup.status, setup.stdout + setup.stderr).toBe(0);
    // Setup's denied app-opening attempt is retained above, not a foreground action.
    writeFileSync(join(f.home, "manager.log"), "");
    const child = launch(args, f, "foreground");
    try {
      const observedReady = await ready(f, child);
      receipt(f, { observedReady, exitCode: child.exitCode, signalCode: child.signalCode });
      expect(observedReady).toBe(true);
      assertNoDescriptors(f);
      assertIsolation(f);
      const pid = await createPty(f);
      await stop(child, entry === "package");
      await until(() => !alive(pid), 2000);
      const brokerAlive = await brokerReady(f);
      receipt(f, { brokerAlive, ptyAlive: alive(pid), exitCode: child.exitCode, signalCode: child.signalCode });
      expect(brokerAlive).toBe(false);
      expect(alive(pid)).toBe(false);
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    } finally { receipt(f, { phase: "before-backstop", exitCode: child.exitCode, signalCode: child.signalCode }); }
  }, 40000);
}

const node = Bun.which("node");
for (const runtime of [{ name: "bun", path: process.execPath }, { name: "node", path: node ? realpathSync(node) : undefined }]) {
  for (const reused of [false, true]) {
    for (const group of [false, true]) {
      test.skipIf(!runtime.path)(`${runtime.name} package ${group ? "group Ctrl-C" : "PID SIGTERM"}: ${reused ? "preserves independent broker/PTY" : "stops owned broker/PTY"}, chooses package over damaged stable`, async () => {
        const f = fixture();
        const stable = join(f.home, ".wolfpack", "bin", "wolfpack-broker");
        const damaged = Buffer.from(readFileSync(brokerBinary));
        damaged.fill(0, 0, 4);
        writeFileSync(stable, damaged, { mode: 0o755 });
        let independent: ChildProcess | undefined;
        let pid: number | undefined;
        if (reused) {
          independent = launch([brokerBinary], f, "independent");
          expect(await until(() => existsSync(f.socketPath))).toBe(true);
          expect(await brokerReady(f)).toBe(true);
          pid = await createPty(f);
        }
        const child = launch([runtime.path!, runner], f, "foreground", { http_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "" });
        try {
          const observedReady = await ready(f, child);
          receipt(f, { observedReady, reused, group, runtime: runtime.name, exitCode: child.exitCode });
          expect(observedReady).toBe(true);
          expect(await until(() => readFileSync(join(f.home, "foreground.log"), "utf8").includes("Local: http"))).toBe(true);
          assertIsolation(f);
          assertNoDescriptors(f);
          expect(readFileSync(stable).equals(damaged)).toBe(true);
          expect(existsSync(join(f.home, ".wolfpack", "bin", "wolfpack"))).toBe(false);
          pid ??= await createPty(f);
          await stop(child, group);
          if (!reused) await until(() => !alive(pid!), 2000);
          const responsive = await brokerReady(f);
          receipt(f, { responsive, ptyAlive: alive(pid), exitCode: child.exitCode, signalCode: child.signalCode, independentExit: independent?.exitCode });
          expect(child.exitCode).toBe(0);
          expect(child.signalCode).toBeNull();
          expect(responsive).toBe(reused);
          expect(alive(pid)).toBe(reused);
          if (independent) expect(independent.exitCode).toBeNull();
        } finally { receipt(f, { phase: "before-backstop", pid, childExit: child.exitCode }); }
      }, 35000);
    }
  }
}

function managedFixture(f: Fixture, refuse = false): void {
  const uid = process.getuid!();
  const domain = `gui/${uid}`;
  const serverTarget = `${domain}/com.wolfpack.server`;
  const brokerTarget = `${domain}/com.wolfpack.broker`;
  const plist = join(f.home, "Library/LaunchAgents/com.wolfpack.server.plist");
  const unit = join(f.home, ".config/systemd/user/wolfpack.service");
  for (const path of [plist, unit]) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "fixture descriptor\n"); }
  executable(join(f.env.PATH!, "launchctl"), `#!/bin/sh
printf 'launchctl %s\\n' "$*" >> '${f.home}/manager.log'
case "$*" in
  'print ${serverTarget}'|'print ${brokerTarget}') printf 'pid = 123\\n'; exit 0 ;;
  'bootstrap ${domain} ${plist}'|'kickstart ${serverTarget}') exit ${refuse ? 44 : 0} ;;
  'bootout ${serverTarget}') exit 0 ;;
  *) exit 97 ;;
esac
`);
  executable(join(f.env.PATH!, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> '${f.home}/manager.log'
case "$*" in
  '--user is-active wolfpack'|'--user is-active wolfpack-broker') printf 'active\\n'; exit 0 ;;
  '--user start wolfpack'|'--user restart wolfpack') exit ${refuse ? 44 : 0} ;;
  '--user stop wolfpack'|'--user daemon-reload'|'--user enable wolfpack'|'--user enable wolfpack-broker') exit 0 ;;
  *) exit 97 ;;
esac
`);
}

for (const boundary of ["unavailable", "degraded", "refused", "healthy", "install-healthy", "ordinary-unavailable", "restart-unavailable", "reload-unavailable", "install-unavailable"] as const) {
  test(`managed ${boundary}: actual CLI gates success on real endpoint health`, async () => {
    const f = fixture();
    managedFixture(f, boundary === "refused");
    const healthy = boundary === "healthy" || boundary === "install-healthy";
    if (boundary === "degraded" || healthy) {
      const entry = join(f.home, "endpoint.ts");
      writeFileSync(entry, `Bun.serve({hostname:'127.0.0.1',port:${f.port},fetch:()=>Response.json(${JSON.stringify({ status: healthy ? "ready" : "degraded", broker: { state: healthy ? "ready" : "unavailable" } })})});`);
      const listener = launch([process.execPath, entry], f, "independent");
      const deadline = Date.now() + 3000;
      let bound = false;
      while (!bound && Date.now() < deadline) { try { await health(f.port); bound = true; } catch { await Bun.sleep(25); } }
      expect(bound).toBe(true);
      expect(exited(listener)).toBe(false);
    }
    let args: readonly string[];
    if (boundary === "reload-unavailable") {
      const entry = join(f.home, "reload.ts");
      writeFileSync(entry, `import { refreshInstalledServerService } from ${JSON.stringify(join(repository, "src/cli/service.ts"))}; refreshInstalledServerService();`);
      args = [process.execPath, entry];
    } else {
      const action = boundary === "restart-unavailable" ? ["service", "restart", "--server-only"] : boundary === "ordinary-unavailable" ? [] : ["service", boundary === "install-unavailable" || boundary === "install-healthy" ? "install" : "start"];
      args = [process.execPath, join(repository, "src/cli/index.ts"), ...action];
    }
    const child = launch(args, f, "managed", { http_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "" });
    try {
      const stopped = await until(() => exited(child), 15000);
      const output = readFileSync(join(f.home, "managed.log"), "utf8");
      receipt(f, { boundary, stopped, exitCode: child.exitCode, signalCode: child.signalCode, output });
      expect(stopped).toBe(true);
      if (healthy) {
        expect(child.exitCode).toBe(0);
        expect(output).toContain(boundary === "install-healthy" ? "service installed and started" : "service started");
      } else {
        expect(child.exitCode).not.toBe(0);
        expect(output).not.toContain("service started");
        expect(output).not.toContain("service installed and started");
        expect(output).not.toContain("and reloaded it");
        expect(output).not.toContain("Local: http");
      }
      expect(readFileSync(join(f.home, "manager.log"), "utf8")).not.toContain("com.wolfpack.broker.plist");
    } finally { receipt(f, { phase: "before-backstop", boundary, exitCode: child.exitCode }); }
  }, 20000);
}

for (const tooling of ["missing", "unlaunchable"] as const) {
  for (const action of ["ordinary", "install", "start", "restart", "pair", "upgrade", "refresh"] as const) {
    test(`curl ${tooling} ${action}: prerequisite fails before managed mutations`, async () => {
      const f = fixture();
      managedFixture(f, false);
      rmSync(join(f.env.PATH!, "curl"));
      if (tooling === "unlaunchable") executable(join(f.env.PATH!, "curl"), "#!/missing-fixture-interpreter\n");
      const state = join(f.home, ".wolfpack");
      executable(join(state, "bin", "wolfpack"), "#!/bin/sh\nexit 17\n");
      for (const name of ["wolfpack.log", "broker.log"]) writeFileSync(join(state, name), "untouched log\n");
      const paths = ["bin/wolfpack", "bin/wolfpack-broker", "service-auth.json", "wolfpack.log", "broker.log"].map(path => join(state, path));
      paths.push(join(f.home, "Library/LaunchAgents/com.wolfpack.server.plist"), join(f.home, ".config/systemd/user/wolfpack.service"));
      const snapshot = () => paths.map(path => existsSync(path) ? readFileSync(path, "base64") : null);
      const before = snapshot();
      let args: readonly string[];
      if (action === "pair" || action === "refresh") {
        const entry = join(f.home, "action.ts");
        const invocation = action === "pair"
          ? `await service.installCandidatePair({server:${JSON.stringify(compiled)},broker:${JSON.stringify(join(suite, "package/wolfpack-broker"))}},'explicit');`
          : "service.refreshInstalledServerService();";
        writeFileSync(entry, `import * as service from ${JSON.stringify(join(repository, "src/cli/service.ts"))}; ${invocation}`);
        args = [process.execPath, entry];
      } else if (action === "upgrade") {
        args = [compiled, "install", join(suite, "package/wolfpack-broker")];
      } else if (action === "ordinary") args = [compiled];
      else args = [process.execPath, join(repository, "src/cli/index.ts"), "service", action, ...(action === "restart" ? ["--broker"] : [])];
      const started = Date.now();
      const child = launch(args, f, "managed", { WOLFPACK_INSTALL_SKIP_SETUP: "1" });
      const stopped = await until(() => exited(child), 12000);
      const output = readFileSync(join(f.home, "managed.log"), "utf8");
      const commands = readFileSync(join(f.home, "manager.log"), "utf8").trim().split("\n").filter(Boolean);
      const domain = `gui/${process.getuid!()}`;
      const readOnly = new Set([
        `launchctl print ${domain}/com.wolfpack.server`, `launchctl print ${domain}/com.wolfpack.broker`,
        "systemctl --user is-active wolfpack", "systemctl --user is-active wolfpack-broker",
      ]);
      const after = snapshot();
      receipt(f, { tooling, action, stopped, durationMs: Date.now() - started, before, after, commands, output });
      expect(stopped).toBe(true);
      expect(child.exitCode).not.toBe(0);
      expect(output).toContain("requires runnable curl on PATH");
      expect(output).not.toContain("Application startup timed out");
      expect(Date.now() - started).toBeLessThan(3000);
      expect(after).toEqual(before);
      expect(commands.every(command => readOnly.has(command))).toBe(true);
      expect(output).not.toContain("Local: http");
    }, 16000);
  }
}

test("fresh bootstrap checks curl at service acceptance, after harmless binary staging", () => {
  const f = fixture();
  rmSync(join(f.env.PATH!, "curl"));
  rmSync(join(f.home, ".wolfpack", "config.json"));
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-B", join(repository, "tests/fixtures/installation-setup-pty.py"), compiled, "install", join(suite, "package/wolfpack-broker")], {
    cwd: f.home, env: f.env, input: `\n${f.port}\nskip\nn\ny\n`, encoding: "utf8", timeout: 20000,
  });
  const output = result.stdout + result.stderr;
  writeFileSync(join(f.home, "setup.log"), output);
  receipt(f, { status: result.status, error: result.error?.message, output });
  expect(result.status).toBe(1);
  expect(output).toContain("Start wolfpack automatically on login?");
  expect(output).toContain("requires runnable curl on PATH");
  expect(readFileSync(join(f.home, ".wolfpack/bin/wolfpack"))).toEqual(readFileSync(compiled));
  expect(existsSync(join(f.home, ".wolfpack/service-auth.json"))).toBe(false);
  assertNoDescriptors(f);
  expect(readFileSync(join(f.home, "manager.log"), "utf8")).not.toMatch(/(?:bootstrap|bootout|kickstart|daemon-reload|enable|restart)/);
}, 25000);

test("curl-free fresh skip-setup installs only the binary pair", async () => {
  const f = fixture();
  rmSync(join(f.env.PATH!, "curl"));
  const child = launch([compiled, "install", join(suite, "package/wolfpack-broker")], f, "managed", { WOLFPACK_INSTALL_SKIP_SETUP: "1" });
  const stopped = await until(() => exited(child), 3000);
  receipt(f, { stopped, exitCode: child.exitCode });
  expect(stopped).toBe(true);
  expect(child.exitCode).toBe(0);
  expect(readFileSync(join(f.home, ".wolfpack/bin/wolfpack"))).toEqual(readFileSync(compiled));
  assertNoDescriptors(f);
});

test("curl-free non-activating refresh does not require the activation prerequisite", async () => {
  const f = fixture();
  managedFixture(f, false);
  rmSync(join(f.env.PATH!, "curl"));
  const entry = join(f.home, "refresh.ts");
  writeFileSync(entry, `import {refreshInstalledServerService} from ${JSON.stringify(join(repository, "src/cli/service.ts"))}; refreshInstalledServerService({reload:false});`);
  const child = launch([process.execPath, entry], f, "managed");
  const stopped = await until(() => exited(child), 3000);
  const output = readFileSync(join(f.home, "managed.log"), "utf8");
  receipt(f, { stopped, exitCode: child.exitCode, output });
  expect(stopped).toBe(true);
  expect(child.exitCode).toBe(0);
  expect(output).toContain("Refreshed installed server service descriptor");
  expect(output).not.toContain("and reloaded it");
});

test("occupied unrelated healthy port cannot bless foreground child and owned broker stops", async () => {
  const f = fixture();
  const listener = Bun.serve({ hostname: "127.0.0.1", port: f.port, fetch: () => Response.json({ status: "ready", broker: { state: "ready" } }) });
  const child = launch([process.execPath, join(repository, "src/cli/index.ts")], f, "foreground");
  try {
    const stopped = await until(() => exited(child), 12000);
    const responsive = await brokerReady(f);
    const output = readFileSync(join(f.home, "foreground.log"), "utf8");
    receipt(f, { stopped, responsive, exitCode: child.exitCode, output });
    expect(stopped).toBe(true);
    expect(child.exitCode).not.toBe(0);
    expect(output).not.toContain("Local: http");
    expect(responsive).toBe(false);
    expect(listener.port).toBe(f.port);
  } finally { receipt(f, { phase: "before-backstop" }); listener.stop(true); }
}, 20000);
