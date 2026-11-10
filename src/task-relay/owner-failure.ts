/** Safe worker-boundary diagnostics. Never serialize native errors, paths or payloads. */
const FAILURE_POLICY = {
  RELAY_STORAGE_BUSY: { retryable: true, uncertain: false },
  RELAY_STORAGE_UNAVAILABLE: { retryable: true, uncertain: false },
  RELAY_STORAGE_INVALID: { retryable: false, uncertain: false },
  RELAY_STORAGE_UNCERTAIN: { retryable: true, uncertain: true },
  RELAY_STORAGE_RECOVERY_BLOCKED: { retryable: false, uncertain: true },
} as const;
export type RelayOwnerFailureCode = keyof typeof FAILURE_POLICY;
export interface RelayOwnerFailureData {
  readonly kind: "owner-fatal";
  readonly ownerFatal: true;
  readonly code: RelayOwnerFailureCode;
  readonly retryable: boolean;
  readonly mayHaveBeenDelivered?: true;
}
export class RelayOwnerFailure extends Error {
  readonly failure: RelayOwnerFailureData;
  constructor(readonly code: RelayOwnerFailureCode, cause?: unknown) {
    super(code, { cause }); this.name = "RelayOwnerFailure";
    const policy = FAILURE_POLICY[code];
    this.failure = Object.freeze({ kind: "owner-fatal", ownerFatal: true, code,
      retryable: policy.retryable, ...(policy.uncertain && { mayHaveBeenDelivered: true as const }) });
  }
}
export function isRelayOwnerFailureData(value: unknown): value is RelayOwnerFailureData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<RelayOwnerFailureData>;
  if (data.kind !== "owner-fatal" || data.ownerFatal !== true || typeof data.code !== "string" || !Object.hasOwn(FAILURE_POLICY, data.code)) return false;
  const policy = FAILURE_POLICY[data.code as RelayOwnerFailureCode];
  return data.retryable === policy.retryable && (policy.uncertain ? data.mayHaveBeenDelivered === true : data.mayHaveBeenDelivered === undefined);
}
export class RelayRecoveryCooldown extends Error {
  readonly code = "RELAY_STORAGE_RECOVERING";
  constructor(readonly retryAfterMs: number) { super("relay owner recovery is cooling down; request not admitted"); this.name = "RelayRecoveryCooldown"; }
}
const TRANSIENT_OPEN_CODES = new Set([
  "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "EMFILE", "ENFILE", "ENOMEM", "ENOENT",
  "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_FULL", "SQLITE_CANTOPEN",
]);
export function relayOpenFailure(error: unknown): RelayOwnerFailure {
  if (error instanceof RelayOwnerFailure) return error;
  const native = error as { code?: string; errcode?: number } | undefined;
  const primary = typeof native?.errcode === "number" ? native.errcode & 0xff : undefined;
  const code: RelayOwnerFailureCode = native?.code === "SQLITE_BUSY" || native?.code === "SQLITE_LOCKED" || primary === 5 || primary === 6
    ? "RELAY_STORAGE_BUSY" : TRANSIENT_OPEN_CODES.has(native?.code ?? "") || (primary !== undefined && [8, 10, 13, 14].includes(primary))
      ? "RELAY_STORAGE_UNAVAILABLE" : "RELAY_STORAGE_INVALID";
  return new RelayOwnerFailure(code, error);
}
