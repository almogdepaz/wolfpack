/**
 * `hello` handshake classification shared by the server and `wolfpack doctor`.
 * See docs/broker-protocol.md "hello" and "Versioning".
 */

/** Must match `broker/src/protocol.rs` `PROTOCOL_VERSION`. */
export const BROKER_PROTOCOL_VERSION = 2;
export const BROKER_HELLO_METHOD = "hello";

export interface BrokerVersionInfo {
  readonly protocolVersion: number;
  readonly brokerVersion: string;
}

export type BrokerHelloResult =
  | ({ readonly kind: "compatible" } & BrokerVersionInfo)
  | ({ readonly kind: "incompatible" } & BrokerVersionInfo)
  /** The broker answered `unknown_method`: it predates `hello`, version unknown. */
  | { readonly kind: "pre_hello" }
  | { readonly kind: "error"; readonly message: string };

export function classifyBrokerHello(response: unknown): BrokerHelloResult {
  const resp = response as {
    status?: unknown;
    payload?: { kind?: unknown; protocol_version?: unknown; broker_version?: unknown };
    error?: { code?: unknown; message?: unknown };
  } | null;
  if (resp?.status !== "ok") {
    if (resp?.error?.code === "unknown_method") return { kind: "pre_hello" };
    const code = typeof resp?.error?.code === "string" ? resp.error.code : "no error code";
    return { kind: "error", message: `hello returned status=${String(resp?.status)} (${code})` };
  }
  const payload = resp.payload;
  if (payload?.kind !== BROKER_HELLO_METHOD
    || !Number.isInteger(payload.protocol_version)
    || typeof payload.broker_version !== "string") {
    return { kind: "error", message: "hello returned a malformed payload" };
  }
  const info = { protocolVersion: payload.protocol_version as number, brokerVersion: payload.broker_version };
  return info.protocolVersion === BROKER_PROTOCOL_VERSION
    ? { kind: "compatible", ...info }
    : { kind: "incompatible", ...info };
}
