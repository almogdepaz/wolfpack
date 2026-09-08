#!/usr/bin/env bun
/** Read-only adapter audit against a real, privately rooted relay gateway.
 * Usage: bun scripts/relay-memory-compat-audit.ts /absolute/path/to/wolfpack-task-relay.ts
 * The explicitly selected adapter module executes locally. No default broker,
 * real HTTP/Tailnet, endpoint task store, installed package or service is used/modified.
 * Exit 1 means a compatibility defect was reproduced, not a harness success claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AGENT_KIND } from "../src/agent-kind.ts";
import { TaskRelayGateway } from "../src/task-relay/gateway.ts";
import { RELAY_PROTOCOL_VERSION, type RelayEnvelope as WireEnvelope } from "../src/task-relay/domain.ts";

const selected = process.argv[2];
assert(selected && isAbsolute(selected), "explicit absolute adapter source path required");
const adapterPath = realpathSync(selected);
const sha = () => createHash("sha256").update(readFileSync(adapterPath)).digest("hex");
const adapterSha256 = sha();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).trim();
const { createWolfpackTaskRelay } = await import(adapterPath);
const { TASK_PROTOCOL_VERSION } = await import(join(dirname(adapterPath), "task-protocol.ts"));
const root = mkdtempSync(join(tmpdir(), "wolfpack-relay-compat-audit-"));
const gateway = new TaskRelayGateway({ root, inspectSession: async selector => ({
  ok: true, session: selector, sessionId: selector, projectPath: root, harness: AGENT_KIND.PI.id, alive: true,
}) });
let dropFirstAcceptedResponse = true, simulateRemovedCursorOne = false;
const sent: { envelope: WireEnvelope; result: unknown }[] = [];
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://compat-audit.invalid");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  let result: unknown;
  switch (url.pathname) {
    case "/api/task-relay/v2/connect": result = await gateway.connect(body); break;
    case "/api/task-relay/v2/send": {
      const reply = await gateway.send(body);
      sent.push({ envelope: structuredClone(body.envelope), result: reply });
      if (reply.ok && dropFirstAcceptedResponse) {
        dropFirstAcceptedResponse = false;
        throw new Error("injected response loss AFTER actual relay acceptance");
      }
      result = reply; break;
    }
    case "/api/task-relay/v2/receive":
      // This explicitly simulates the proposed post-ack gap, not current v2 behavior.
      result = await gateway.receive({ callerSession: url.searchParams.get("callerSession")!,
        cursor: simulateRemovedCursorOne ? "1" : url.searchParams.get("cursor")! }); break;
    case "/api/task-relay/v2/delivery-ack": result = await gateway.acknowledgeDelivery(body); break;
    default: throw new Error(`unexpected audit route: ${url.pathname}`);
  }
  return Response.json(result);
}) as typeof fetch;
const adapter = (sessionName: string) => createWolfpackTaskRelay({ sessionName, generation: "compat-audit",
  baseUrl: "https://compat-audit.invalid", fetch: transport });
try {
  const sender = adapter("sender"), receiver = adapter("receiver");
  const source = await sender.endpoint(), target = await receiver.endpoint();
  const logical = { envelopeId: "lost-response", protocolVersion: TASK_PROTOCOL_VERSION, source, target,
    taskId: "compat-audit-task", kind: "assignment", payload: JSON.stringify({ audit: true }) };
  let firstError: string | undefined, retryError: string | undefined;
  try { await sender.send(logical); } catch (error) { firstError = (error as { code?: string }).code ?? String(error); }
  assert(firstError, "response-loss injection must be observed by the adapter");
  await Bun.sleep(20); // ensure the second serialization happens at a distinct wall-clock time
  try { await sender.send(logical); } catch (error) { retryError = (error as { code?: string }).code ?? String(error); }
  assert.equal(sent.length, 2);
  const original = sent[0]!.envelope;
  const exactRetry = await gateway.send({ callerSession: "sender", envelope: original });
  assert(exactRetry.ok && exactRetry.kind === "duplicate", "actual relay must deduplicate exact retry bytes");
  const changed = await gateway.send({ callerSession: "sender", envelope: { ...original, payload: { changed: true } } });
  assert(!changed.ok && changed.error.code === "ENVELOPE_CONFLICT", "genuine changed content must still conflict");
  const before = await gateway.receive({ callerSession: "receiver", cursor: "0" });
  assert(before.ok && before.envelopes.length === 1, "response loss must not produce multiple relay deliveries");
  await sender.send({ ...logical, envelopeId: "after-gap" });
  const ack = await gateway.acknowledgeDelivery({ callerSession: "receiver", envelopeId: original.envelopeId });
  assert(ack.ok);
  const realSecondPage = await gateway.receive({ callerSession: "receiver", cursor: "1" });
  assert(realSecondPage.ok && realSecondPage.envelopes.length === 1 && realSecondPage.nextCursor === "2");
  simulateRemovedCursorOne = true;
  const page = await receiver.receive({ endpoint: target, cursor: "0", limit: 50 });
  assert.equal(page.deliveries.length, 1);
  const changedRetryContent = JSON.stringify(sent[0]!.envelope) !== JSON.stringify(sent[1]!.envelope);
  const wrongGapCursor = page.deliveries[0].cursor !== realSecondPage.nextCursor;
  assert.equal(sha(), adapterSha256, "selected adapter source changed during audit");
  console.log(JSON.stringify({ revision, adapterPath, adapterSha256, wireProtocolVersion: RELAY_PROTOCOL_VERSION,
    firstError, retryError, changedRetryContent,
    firstCreatedAt: sent[0]!.envelope.createdAt, retryCreatedAt: sent[1]!.envelope.createdAt,
    exactRetryKind: exactRetry.kind, genuineConflict: changed.error.code,
    cursorGap: { simulatedRemoval: true, actualCursor: realSecondPage.nextCursor, assignedCursor: page.deliveries[0].cursor, wrongGapCursor },
    scope: "real installed adapter + real private gateway/store; injected HTTP transport and response loss; proposed cursor gap simulated; no task core/store or live services" }));
  if (changedRetryContent || retryError || wrongGapCursor) process.exitCode = 1;
} finally {
  gateway.close();
  rmSync(root, { recursive: true, force: true });
}
