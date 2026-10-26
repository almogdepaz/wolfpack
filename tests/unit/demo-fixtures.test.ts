import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURES_DIR,
  TRANSCRIPTS_DIR,
  loadFixtures,
  parseTranscript,
  readTranscript,
  renderInstantly,
  transcriptDurationMs,
  validateFixtures,
} from "../../scripts/demo/fixtures";
import { FFMPEG_TOOL, fixtureServerEnv, parseArgs, resolveTool, startFixtureServer } from "../../scripts/demo/lib";
import { TARGETS, scenesSafeToDelete, writeConcatList } from "../../scripts/demo/encode";
import {
  PrivacyViolation,
  assertClean,
  findForbidden,
  findSecrets,
  forbiddenStrings,
  interfaceAddresses,
  mask,
  publicAllowlist,
  scanPaths,
} from "../../scripts/demo/privacy-gate";

const ESC = "\x1b";
/** This machine's identity probes are developer-machine guards; CI runners share generic accounts and hosts. */
const machineProbe = process.env.CI ? test.skip : test;
let scratch = "";

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

function tempDir(): string {
  scratch = mkdtempSync(join(tmpdir(), "wolfpack-demo-test-"));
  return scratch;
}

describe("transcript format", () => {
  test("emits content with CRLF, escapes and style tags", () => {
    const steps = parseTranscript("{green}ok{/} done\nraw \\e[1mbold\\e[0m \\\\ slash\nprompt? \\c\n");
    expect(steps).toEqual([{
      kind: "emit",
      text: `${ESC}[38;2;69;237;126mok${ESC}[0m done\r\nraw ${ESC}[1mbold${ESC}[0m \\ slash\r\nprompt? `,
    }]);
  });

  test("parses pauses, typing, status, comments and literal @ lines", () => {
    const steps = parseTranscript([
      "@# setup",
      "first",
      "@+250",
      "@type 40 yes",
      '@status {"state":"blocked","kind":"permission","message":"Allow?"}',
      "@@mention",
      "@status null",
    ].join("\n"));
    expect(steps).toEqual([
      { kind: "emit", text: "first\r\n" },
      { kind: "pause", ms: 250 },
      { kind: "type", msPerChar: 40, text: "yes" },
      { kind: "status", status: { state: "blocked", kind: "permission", message: "Allow?" } },
      { kind: "emit", text: "@mention\r\n" },
      { kind: "status", status: null },
    ]);
    expect(transcriptDurationMs(steps)).toBe(250 + 3 * 40);
    expect(renderInstantly(steps)).toEqual({ text: "first\r\nyes@mention\r\n", status: null });
  });

  test("rejects unknown directives, escapes and status fields with a line reference", () => {
    expect(() => parseTranscript("ok\n@wait 3", "t.ans")).toThrow("t.ans:2");
    expect(() => parseTranscript("bad \\q escape", "t.ans")).toThrow("unknown escape");
    expect(() => parseTranscript('@status {"state":"busy"}')).toThrow("invalid status state");
    expect(() => parseTranscript('@status {"state":"idle","color":"red"}')).toThrow("unknown status field");
    expect(() => parseTranscript("@status {nope")).toThrow("not valid JSON");
  });

  test("every committed transcript parses", () => {
    const files = readdirSync(TRANSCRIPTS_DIR).filter((file) => file.endsWith(".ans"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(readTranscript(file).length).toBeGreaterThan(0);
  });
});

describe("sessions.json", () => {
  test("the committed fixtures validate: fictional hosts, known parents, deferred spawn targets", () => {
    const fixtures = loadFixtures();
    expect(Object.values(fixtures.machines).every((machine) => machine.host.endsWith(".example.ts.net"))).toBe(true);
    const needsInput = fixtures.sessions.filter((session) =>
      renderInstantly(readTranscript(session.screen)).status?.state === "blocked" && !session.deferred);
    expect(needsInput.map((session) => session.name).sort()).toEqual(["api-gateway", "mobile-app"]);
    expect(fixtures.sessions.filter((session) => !session.deferred)).toHaveLength(8);
  });

  const base = () => JSON.parse(readFileSync(join(FIXTURES_DIR, "sessions.json"), "utf8")) as {
    machines: Record<string, { host: string }>;
    sessions: Array<Record<string, unknown>>;
  };

  test("rejects real-looking hosts, unknown parents, missing transcripts and non-deferred spawn targets", () => {
    const realHost = base();
    realHost.machines.workstation!.host = "workstation.tail1234.ts.net";
    expect(() => validateFixtures(realHost)).toThrow("fictional");

    const orphan = base();
    orphan.sessions[0]!.parent = "no-such-parent";
    expect(() => validateFixtures(orphan)).toThrow("parent no-such-parent");

    expect(() => validateFixtures(base(), (file) => file !== "docs-site.ans")).toThrow("missing screen transcript docs-site.ans");

    const eager = base();
    const child = eager.sessions.find((session) => session.name === "201-load-test")!;
    delete child.deferred;
    expect(() => validateFixtures(eager)).toThrow("deferred child");
  });
});

describe("privacy gate", () => {
  test("matches case-insensitively and masks what it found", () => {
    expect(findForbidden("Hello SecretHost.local", ["secrethost"])).toEqual(["secrethost"]);
    expect(mask("secrethost")).toBe("s********t (10 chars)");
    let error: unknown;
    try {
      assertClean("<p>secrethost</p>", "page", ["secrethost"], []);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PrivacyViolation);
    expect(String(error)).toContain("s********t");
    expect(String(error)).not.toContain("secrethost");
  });

  test("allows the public GitHub owner from package.json while still catching the bare name", () => {
    const owners = publicAllowlist();
    expect(owners.length).toBeGreaterThan(0);
    const owner = owners[0]!;
    const fragment = owner.slice(0, Math.max(3, owner.length - 2));
    expect(findForbidden(`https://${owner}.github.io/wolfpack/`, [fragment], owners)).toEqual([]);
    expect(findForbidden(`/Users/${fragment}/dev`, [fragment], owners)).toEqual([fragment]);
  });

  test("drops strings too short to forbid and scans directories for every hit", () => {
    expect(forbiddenStrings(["ab", " longer-value "], { probeSystem: false })).toEqual(["longer-value"]);
    const dir = tempDir();
    writeFileSync(join(dir, "a.vtt"), "WEBVTT\n\nshows longer-value here");
    writeFileSync(join(dir, "b.json"), "{}");
    writeFileSync(join(dir, "c.png"), "longer-value");
    const { scanned, hits } = scanPaths([dir], ["longer-value"], []);
    expect(scanned).toBe(2);
    expect(hits.map((hit) => hit.where)).toEqual([join(dir, "a.vtt")]);
  });

  test("catches planted credentials and interface addresses", () => {
    const planted = [
      ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
      ["tskey", "-auth-", "kAbCdEf1CNTRL-0123456789abcdef"].join(""),
      ["ey", "JhbGciOiJIUzI1NiJ9", ".ey", "JzdWIiOiJkZW1vLXVzZXIifQ", ".c2lnbmF0dXJlLXZhbHVl"].join(""),
      ["sk", "-ant-", "api03-0123456789abcdefghijklmnop"].join(""),
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join(""),
    ];
    for (const secret of planted) expect(findSecrets(`config: ${secret} end`)).toEqual([secret]);
    expect(findSecrets("session.state eyJ is fine, ghp_short too, tskey-only")).toEqual([]);
    const dir = tempDir();
    writeFileSync(join(dir, "page.html"), `<pre>${planted[0]}</pre>`);
    expect(scanPaths([dir], [], []).hits).toHaveLength(1);

    const addresses = interfaceAddresses({
      eth0: [
        { address: "192.0.2.44", netmask: "255.255.255.0", family: "IPv4", mac: "02:42:ac:11:00:02", internal: false, cidr: null },
        { address: "fe80::42:acff:fe11:2%eth0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "02:42:ac:11:00:02", internal: false, cidr: null, scopeid: 2 },
      ],
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: null }],
    });
    expect(addresses).toEqual(["192.0.2.44", "02:42:ac:11:00:02", "fe80::42:acff:fe11:2", "02:42:ac:11:00:02"]);
    expect(findForbidden("peer at 192.0.2.44:18790", addresses)).toEqual(["192.0.2.44"]);
    for (const address of interfaceAddresses()) expect(forbiddenStrings()).toContain(address);
  });

  machineProbe("committed demo sources contain none of this machine's identifying strings", () => {
    const { hits } = scanPaths([join(import.meta.dirname, "..", "..", "scripts", "demo")], forbiddenStrings());
    expect(hits).toEqual([]);
  });
});

describe("recorder and encoder helpers", () => {
  test("parses flags and names the env var when a tool is missing", () => {
    expect([...parseArgs(["--scene", "desktop", "--dry"])]).toEqual([["scene", "desktop"], ["dry", "true"]]);
    expect(() => parseArgs(["desktop"])).toThrow("unexpected argument");
    expect(() => resolveTool(FFMPEG_TOOL, {})).toThrow("WOLFPACK_FFMPEG is not set");
    expect(() => resolveTool(FFMPEG_TOOL, { WOLFPACK_FFMPEG: "/nonexistent/ffmpeg" })).toThrow("does not exist");
  });

  test("frames are deleted only when every target of their scene was encoded in the run", () => {
    const desktopTargets = TARGETS.filter((target) => target.scene === "desktop").map((target) => target.name);
    expect(desktopTargets.length).toBeGreaterThan(1);
    expect(scenesSafeToDelete(new Set(["hero"]))).toEqual([]);
    expect(scenesSafeToDelete(new Set(desktopTargets))).toEqual(["desktop"]);
    expect(scenesSafeToDelete(new Set(TARGETS.map((target) => target.name))).sort()).toEqual(["cards", "cli", "desktop", "mobile"]);
  });

  test("fixture servers get no WOLFPACK_* setting from the operator except WOLFPACK_TEST", () => {
    const env = fixtureServerEnv({ PATH: "/bin", WOLFPACK_PORT: "18790", WOLFPACK_BROKER_BIN: "/x", WOLFPACK_TEST: "0", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", WOLFPACK_TEST: "1" });
  });

  test("concat lists hold each frame until the next one, scaled by speed, then hold the last", () => {
    const dir = tempDir();
    const listPath = join(dir, "list.txt");
    const frames = [0, 0.5, 1.5, 2].map((timestamp, index) => ({ file: `f${index}.png`, timestamp }));
    const seconds = writeConcatList(frames, { start: 1, end: 3, speed: 2, holdEnd: 1, listPath, framesDir: join(dir, "frames") });
    expect(seconds).toBeCloseTo(0.5 + 0.25 + 1, 5);
    expect(readFileSync(listPath, "utf8")).toBe(
      "file 'frames/f1.png'\nduration 0.5000\nfile 'frames/f2.png'\nduration 0.2500\nfile 'frames/f3.png'\nduration 1.0000\nfile 'frames/f3.png'\n",
    );
  });
});

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("fixture server", () => {
  test("an interrupted recorder takes its fixture servers down with it", async () => {
    const dir = tempDir();
    const script = join(dir, "interrupted.ts");
    writeFileSync(script, [
      `import { startFixtureServer } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "scripts", "demo", "lib.ts"))};`,
      "const servers = await Promise.all([startFixtureServer(\"workstation\"), startFixtureServer(\"macbook\")]);",
      "console.log(`PIDS:${servers.map((server) => server.pid).join(\",\")}`);",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const recorder = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const reader = recorder.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    const pids = /PIDS:([\d,]+)/.exec(output)?.[1]?.split(",").map(Number) ?? [];
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(processGroupAlive(pid)).toBe(true);
    recorder.kill("SIGINT");
    expect(await recorder.exited).toBe(130);
    const deadline = Date.now() + 5000;
    while (pids.some(processGroupAlive) && Date.now() < deadline) await Bun.sleep(50);
    expect(pids.filter(processGroupAlive)).toEqual([]);
  }, 40_000);

  test("serves fixture identities and states instead of this machine's name", async () => {
    const server = await startFixtureServer("workstation");
    try {
      const info = await (await fetch(`${server.baseUrl}/api/info`)).json() as { name: string };
      expect(info.name).toBe("Workstation");
      const machine = await (await fetch(`${server.baseUrl}/api/machine`)).json() as { machine: { origin: string } };
      expect(machine.machine.origin).toBe("https://workstation.example.ts.net");
      const { sessions } = await (await fetch(`${server.baseUrl}/api/sessions`)).json() as {
        sessions: Array<{ name: string; lastLine: string; runtimeState?: { state: string }; identity?: { agentKind: string } }>;
      };
      const gateway = sessions.find((session) => session.name === "api-gateway");
      expect(gateway?.runtimeState?.state).toBe("needs-input");
      expect(gateway?.lastLine).toBe("Allow edit to src/server/routes.ts? (y/n)");
      expect(gateway?.identity?.agentKind).toBe("claude");
      expect(sessions.some((session) => session.name === "200-security-review")).toBe(false);
      if (!process.env.CI) assertClean(JSON.stringify({ info, machine, sessions }), "fixture api", forbiddenStrings());
    } finally {
      await server.close();
    }
  }, 30_000);
});
