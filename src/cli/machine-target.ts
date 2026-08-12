import {
  canonicalTailnetOrigin,
  classifyMachineHandshakeForOrigin,
} from "../tailnet-machine-contract.js";
import type { MachineHandshake } from "../tailnet-machine-contract.js";

const MACHINE_SELECTOR = "--machine";
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MACHINE_HANDSHAKE_MAX_BYTES = 32 * 1024;
const MACHINE_HANDSHAKE_TIMEOUT_MS = 8_000;

export interface VerifiedMachineTarget {
  readonly kind: "remote";
  readonly origin: string;
  readonly machine: MachineHandshake["machine"];
}

export interface MachineTargetFailure {
  readonly code:
    | "INVALID_MACHINE_SELECTOR"
    | "MACHINE_CONFIGURATION_REQUIRED"
    | "MACHINE_UNREACHABLE"
    | "MACHINE_AUTH_REQUIRED"
    | "INVALID_MACHINE_RESPONSE"
    | "INCOMPATIBLE_MACHINE";
  readonly message: string;
  readonly exitCode: number;
}

export type ExtractedMachineSelector =
  | {
    readonly ok: true;
    readonly selector: string | undefined;
    readonly argv: readonly string[];
  }
  | { readonly ok: false; readonly error: MachineTargetFailure };

export type MachineOriginResolution =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly error: MachineTargetFailure };

export type MachineTargetVerification =
  | { readonly ok: true; readonly target: VerifiedMachineTarget }
  | { readonly ok: false; readonly error: MachineTargetFailure };

export type MachineTargetFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface VerifyMachineTargetOptions {
  readonly tailscaleHostname: string | undefined;
  readonly jwt?: string | null;
  readonly fetcher?: MachineTargetFetch;
  readonly timeoutMs?: number;
}

function failure(
  code: MachineTargetFailure["code"],
  message: string,
  exitCode = 1,
): MachineTargetFailure {
  return { code, message, exitCode };
}

function isMachineSelectorArgument(value: string): boolean {
  return value === MACHINE_SELECTOR || value.startsWith(`${MACHINE_SELECTOR}=`);
}

export function extractMachineSelector(argv: readonly string[]): ExtractedMachineSelector {
  if (!isMachineSelectorArgument(argv[0] ?? "")) {
    if (argv.some(isMachineSelectorArgument)) {
      return {
        ok: false,
        error: failure(
          "INVALID_MACHINE_SELECTOR",
          "--machine must be the sole leading global selector",
          2,
        ),
      };
    }
    return { ok: true, selector: undefined, argv: [...argv] };
  }
  if (argv[0] !== MACHINE_SELECTOR) {
    return {
      ok: false,
      error: failure(
        "INVALID_MACHINE_SELECTOR",
        "use the leading --machine <short-name-or-fqdn> selector form",
        2,
      ),
    };
  }
  const selector = argv[1];
  if (!selector || selector.startsWith("-")) {
    return {
      ok: false,
      error: failure("INVALID_MACHINE_SELECTOR", "--machine requires a machine name", 2),
    };
  }
  const remaining = argv.slice(2);
  if (remaining.some(isMachineSelectorArgument)) {
    return {
      ok: false,
      error: failure("INVALID_MACHINE_SELECTOR", "duplicate --machine selector", 2),
    };
  }
  return { ok: true, selector, argv: remaining };
}

export function resolveMachineOrigin(
  selector: string,
  tailscaleHostname: string | undefined,
): MachineOriginResolution {
  const configuredOrigin = canonicalTailnetOrigin(tailscaleHostname);
  if (!configuredOrigin || configuredOrigin.slice("https://".length) !== tailscaleHostname) {
    return {
      ok: false,
      error: failure(
        "MACHINE_CONFIGURATION_REQUIRED",
        "a canonical tailscaleHostname is required; run 'wolfpack setup'",
      ),
    };
  }

  const configuredLabels = tailscaleHostname.split(".");
  if (configuredLabels.length < 4) {
    return {
      ok: false,
      error: failure(
        "MACHINE_CONFIGURATION_REQUIRED",
        "configured tailscaleHostname does not include a tailnet namespace",
      ),
    };
  }
  const tailnetSuffix = `.${configuredLabels.slice(1).join(".")}`;
  if (!selector.includes(".")) {
    if (!DNS_LABEL_PATTERN.test(selector)) {
      return {
        ok: false,
        error: failure("INVALID_MACHINE_SELECTOR", "--machine must be a canonical DNS name", 2),
      };
    }
    return { ok: true, origin: `https://${selector}${tailnetSuffix}` };
  }

  const selectedOrigin = canonicalTailnetOrigin(selector);
  const selectedHostname = selectedOrigin?.slice("https://".length);
  const machineLabel = selectedHostname?.slice(0, -tailnetSuffix.length);
  if (
    !selectedOrigin
    || selectedHostname !== selector
    || !selectedHostname.endsWith(tailnetSuffix)
    || !machineLabel
    || machineLabel.includes(".")
    || !DNS_LABEL_PATTERN.test(machineLabel)
  ) {
    return {
      ok: false,
      error: failure(
        "INVALID_MACHINE_SELECTOR",
        "--machine must be a short name or canonical hostname in the configured tailnet",
        2,
      ),
    };
  }
  return { ok: true, origin: selectedOrigin };
}

class MachineProbeTimeoutError extends Error {}
class MachineProbeBodyError extends Error {}

function declaredBodyExceedsLimit(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  return contentLength !== null && Number(contentLength) > MACHINE_HANDSHAKE_MAX_BYTES;
}

async function readBoundedBody(
  response: Response,
  expired: Promise<never>,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MACHINE_HANDSHAKE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new MachineProbeBodyError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function verifyMachineTarget(
  selector: string,
  options: VerifyMachineTargetOptions,
): Promise<MachineTargetVerification> {
  const resolved = resolveMachineOrigin(selector, options.tailscaleHostname);
  if (!resolved.ok) return resolved;

  const timeoutMs = options.timeoutMs ?? MACHINE_HANDSHAKE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MachineProbeTimeoutError());
    }, timeoutMs);
  });
  const headers = new Headers();
  if (options.jwt) headers.set("Authorization", `Bearer ${options.jwt}`);

  try {
    const response = await Promise.race([
      (options.fetcher ?? fetch)(`${resolved.origin}/api/machine`, {
        method: "GET",
        headers,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      }),
      expired,
    ]);
    if (response.status === 401) {
      return {
        ok: false,
        error: failure("MACHINE_AUTH_REQUIRED", "machine handshake requires authentication", 5),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: failure("MACHINE_UNREACHABLE", `machine handshake returned HTTP ${response.status}`),
      };
    }
    if (declaredBodyExceedsLimit(response)) {
      controller.abort();
      return {
        ok: false,
        error: failure("INVALID_MACHINE_RESPONSE", "machine handshake exceeds 32 KiB"),
      };
    }

    let body: unknown;
    try {
      const bytes = await readBoundedBody(response, expired);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error: unknown) {
      if (error instanceof MachineProbeTimeoutError) throw error;
      return {
        ok: false,
        error: failure("INVALID_MACHINE_RESPONSE", "machine handshake is not bounded valid JSON"),
      };
    }
    const classification = classifyMachineHandshakeForOrigin(resolved.origin, body);
    if (classification.kind !== "ready") {
      return {
        ok: false,
        error: failure("INCOMPATIBLE_MACHINE", "machine handshake is incompatible with session control"),
      };
    }
    return {
      ok: true,
      target: {
        kind: "remote",
        origin: classification.handshake.machine.origin,
        machine: classification.handshake.machine,
      },
    };
  } catch {
    return {
      ok: false,
      error: failure("MACHINE_UNREACHABLE", "could not verify the selected machine"),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
