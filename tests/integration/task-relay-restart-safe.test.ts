import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("accepted mail, sparse delivery ACK and duplicate acceptance survive actual worker/process restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "restart-safe-relay-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stderr: Promise<string> | undefined;
  const stop = async () => {
    if (!child) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
    try { expect(await child.exited, await stderr).toBe(0); } finally { clearTimeout(timer); child = undefined; }
  };
  const boot = async () => {
    rmSync(join(root, "ready.json"), { force: true });
    child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/restart-safe-relay-process.ts"), root], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, WOLFPACK_DIR: join(root, "state"), WOLFPACK_TEST: "1" }, stdout: "ignore", stderr: "pipe",
    });
    stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(root, "ready.json")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(join(root, "ready.json"))) throw new Error(`fixture startup failed: ${await stderr}`);
    const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
    return async (body: object) => await (await fetch(`http://127.0.0.1:${ready.port}/`, {
      method: "POST", body: JSON.stringify({ profile: ready.profile, ...body }), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    })).json() as any;
  };
  try {
    let post = await boot();
    const sourceSession = randomUUID(), targetSession = randomUUID(), generation = randomUUID();
    const connect = async (session: string) => {
      const reply = await post({ operation: "connect", callerSession: session, generation, protocolVersions: [2] });
      expect(reply.ok).toBe(true);
      return { epoch: reply.epoch, callerSession: session, endpoint: reply.value.endpoint };
    };
    const source = await connect(sourceSession), target = await connect(targetSession);
    const envelopes = [1, 2].map(n => ({ envelopeId: randomUUID(), protocolVersion: 2, createdAt: new Date().toISOString(), source: source.endpoint, target: target.endpoint, payload: { n } }));
    const accepted = await post({ ...source, operation: "send", envelope: envelopes[0] });
    expect(accepted.ok).toBe(true);
    expect((await post({ ...source, operation: "send", envelope: envelopes[1] })).ok).toBe(true);
    const delivered = await post({ ...target, operation: "receive", cursor: "0" });
    expect(delivered.value.deliveries).toHaveLength(2);
    expect((await post({ ...target, operation: "acknowledge", envelopeId: envelopes[1]!.envelopeId })).ok).toBe(true);
    await stop(); post = await boot();
    const resumedSource = await connect(sourceSession), resumedTarget = await connect(targetSession);
    expect(resumedSource).toEqual(source); expect(resumedTarget).toEqual(target);
    const replay = await post({ ...target, operation: "receive", cursor: "0" });
    expect(replay.value.deliveries).toEqual([delivered.value.deliveries[0]]);
    const duplicate = await post({ ...source, operation: "send", envelope: envelopes[0] });
    expect(duplicate.value).toMatchObject({ acceptanceId: accepted.value.acceptanceId, duplicate: true });
    expect((await post({ ...target, operation: "acknowledge", envelopeId: envelopes[1]!.envelopeId })).value.duplicate).toBe(true);
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
