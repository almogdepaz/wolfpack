import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import { isOpaqueRelayId, isRelayEndpoint, isPeerRelayId } from "../task-relay/domain.ts";
import { isLiveTaskRelayRegistration } from "../task-relay/registration.ts";
import type { TaskRelayRegistration } from "../task-relay/registration.ts";

type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => isRelayEndpoint(a) && isRelayEndpoint(b) && a.relay === b.relay && a.id === b.id;
export interface RemoteEndpointOptions {
  readonly origin: string;
  readonly localBase: string;
  readonly callerSession?: string;
  readonly headers: Headers;
  readonly fetch?: typeof fetch;
}

/** Never print a peer-local endpoint in the local tool's taskEndpoint namespace. */
export function unqualifiedRemoteTaskEndpoint(value: unknown, message = "select this exact remote session with session status to resolve its task endpoint"): unknown {
  if (!record(value) || value.taskEndpoint === undefined) return value;
  const { taskEndpoint, taskTransport, ...rest } = value;
  return { ...rest, remoteTaskEndpoint: taskEndpoint, ...(taskTransport !== undefined && { remoteTaskTransport: taskTransport }),
    taskEndpointError: { code: "REMOTE_TASK_ENDPOINT_UNAVAILABLE", message } };
}

async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => undefined); throw new Error("endpoint request refused"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("missing response");
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      if (signal.aborted) throw new Error("endpoint deadline");
      const part = await reader.read(); if (signal.aborted) throw new Error("endpoint deadline"); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 16 * 1024) throw new Error("endpoint metadata too large"); chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

/** CLI selection resolves an exact remote endpoint through the caller's host-verified topology route.
 * Failure retains the remote session identity but removes the unsafe locally-addressable field.
 * It never kills a successfully created remote session or invents task/cleanup state. */
export async function qualifyRemoteTaskEndpoint(value: unknown, options: RemoteEndpointOptions): Promise<unknown> {
  if (!record(value) || value.taskEndpoint === undefined) return value;
  const unavailable = unqualifiedRemoteTaskEndpoint(value, "remote session is retained; local epoch-bound endpoint resolution failed; inspect authentication, relay profile and caller registration");
  if (!isRelayEndpoint(value.taskEndpoint) || !isOpaqueRelayId(value.taskEndpoint.id) || typeof value.sessionId !== "string" || !options.callerSession) return unavailable;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("endpoint resolution deadline")); }, 12_000); });
  const request = async (url: string, init?: RequestInit) => {
    if (controller.signal.aborted) throw new Error("endpoint deadline");
    return body(await (options.fetch ?? fetch)(url, { ...init, headers: options.headers, redirect: "error", cache: "no-store", signal: controller.signal }), controller.signal);
  };
  try {
    return await Promise.race([expired, (async () => {
      const remoteOrigin = new URL(options.origin);
      if (remoteOrigin.origin !== options.origin || canonicalTailnetOrigin(remoteOrigin.hostname) !== options.origin) throw new Error("canonical remote origin required");
      const local = new URL(options.localBase);
      if (local.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(local.hostname) || local.username || local.password || local.search || local.hash || local.pathname !== "/") throw new Error("local origin required");
      const remote = await request(`${options.origin}/api/session-control/status?session=${encodeURIComponent(value.sessionId as string)}`);
      if (!record(remote) || remote.sessionId !== value.sessionId || !same(remote.taskEndpoint, value.taskEndpoint) || !record(remote.taskTransport)
        || !isLiveTaskRelayRegistration(remote.taskTransport as unknown as TaskRelayRegistration, "volatile-v1") || !same(remote.taskTransport.endpoint, value.taskEndpoint)) throw new Error("remote transport changed");
      const source = await request(`${local.origin}/api/session-control/status?session=${encodeURIComponent(options.callerSession!)}`);
      if (!record(source) || !record(source.taskTransport) || !isLiveTaskRelayRegistration(source.taskTransport as unknown as TaskRelayRegistration, "volatile-v1")
        || !same(source.taskEndpoint, source.taskTransport.endpoint)) throw new Error("local task transport unavailable");
      const binding = source.taskTransport;
      const resolved = await request(`${local.origin}/api/task-relay/volatile-v1/resolve-peer`, { method: "POST", body: JSON.stringify({ profile: binding.profile, epoch: binding.epoch,
        callerSession: options.callerSession, endpoint: binding.endpoint, origin: options.origin, target: value.taskEndpoint }) });
      if (!record(resolved) || !resolved.ok || resolved.profile !== "volatile-v1" || resolved.epoch !== binding.epoch || !record(resolved.value)
        || resolved.value.kind !== "resolved" || !isRelayEndpoint(resolved.value.endpoint) || !isPeerRelayId(resolved.value.endpoint.relay)
        || resolved.value.endpoint.id !== (value.taskEndpoint as { id: string }).id) throw new Error("invalid local peer route");
      const { taskTransport: _transport, taskEndpoint: _endpoint, ...rest } = value;
      return { ...rest, taskEndpoint: resolved.value.endpoint, remoteTaskTransport: remote.taskTransport,
        taskRouting: { profile: "volatile-v1", sourceEpoch: binding.epoch, destinationOrigin: options.origin } };
    })()]);
  } catch { return unavailable; }
  finally { clearTimeout(timer); controller.abort(); }
}
