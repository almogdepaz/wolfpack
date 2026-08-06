export const MACHINE_PROTOCOL = {
  NAME: "wolfpack-machine",
  MAJOR: 1,
  MINOR: 0,
} as const;

export const MACHINE_CAPABILITY = {
  SESSIONS: "sessions",
  TERMINAL_WEBSOCKET: "terminal-websocket",
  PUSH_SUBSCRIPTION: "push-subscription",
} as const;

export type MachineCapability = (typeof MACHINE_CAPABILITY)[keyof typeof MACHINE_CAPABILITY];
export const MACHINE_CAPABILITIES: readonly MachineCapability[] = Object.values(MACHINE_CAPABILITY);
export const MACHINE_MAX_CAPABILITIES = MACHINE_CAPABILITIES.length + 32;
export const TAILNET_NODE_ID_PATTERN = "^[A-Za-z0-9_:-]{1,256}$";
export const TAILNET_ORIGIN_PATTERN = "^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.ts\\.net$";

const MACHINE_CAPABILITY_SET = new Set<string>(MACHINE_CAPABILITIES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAILNET_NODE_ID_REGEXP = new RegExp(TAILNET_NODE_ID_PATTERN);
const TAILNET_ORIGIN_REGEXP = new RegExp(TAILNET_ORIGIN_PATTERN);
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_VERSION_LENGTH = 128;
const MAX_CANDIDATES = 1_000;

export interface TailnetMachineCandidate {
  readonly hostname: string;
  readonly tailnetNodeId: string;
  readonly origin: string;
  readonly online: boolean;
}

export type TailnetCandidateEnumeration =
  | { readonly kind: "valid"; readonly candidates: readonly TailnetMachineCandidate[] }
  | { readonly kind: "invalid-local-status" };

export interface MachineHandshakeInput {
  readonly tailscaleHostname: string | undefined;
  readonly tailscaleNodeId: string | undefined;
  readonly installationId: string | undefined;
  readonly displayName: string | undefined;
  readonly version: string | undefined;
}

export interface MachineHandshake {
  readonly protocol: {
    readonly name: typeof MACHINE_PROTOCOL.NAME;
    readonly major: typeof MACHINE_PROTOCOL.MAJOR;
    readonly minor: number;
  };
  readonly machine: {
    readonly tailnetNodeId: string;
    readonly installationId: string;
    readonly displayName: string;
    readonly origin: string;
  };
  readonly wolfpack: { readonly version: string };
  readonly capabilities: readonly MachineCapability[];
}

export type MachineHandshakeClassification =
  | { readonly kind: "ready"; readonly handshake: MachineHandshake }
  | { readonly kind: "non-wolfpack" }
  | { readonly kind: "incompatible" };

interface LocalTailnetIdentity {
  readonly tailscaleHostname: string;
  readonly tailscaleNodeId: string;
}

interface LocalTailnetMachineFacts extends LocalTailnetIdentity {
  readonly displayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedVisibleString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isTailnetNodeId(value: unknown): value is string {
  return typeof value === "string" && TAILNET_NODE_ID_REGEXP.test(value);
}

/** Converts a Tailscale DNS name into the only peer-routing origin this contract accepts. */
export function canonicalTailnetOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  if (hostname.length === 0 || hostname !== hostname.trim()) return null;
  const origin = `https://${hostname.toLowerCase()}`;
  if (!TAILNET_ORIGIN_REGEXP.test(origin)) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && url.hostname === hostname.toLowerCase()
      ? origin
      : null;
  } catch {
    return null;
  }
}

export function buildMachineHandshake(input: MachineHandshakeInput): MachineHandshake | null {
  const origin = canonicalTailnetOrigin(input.tailscaleHostname);
  if (
    !origin
    || !isTailnetNodeId(input.tailscaleNodeId)
    || typeof input.installationId !== "string"
    || !UUID_PATTERN.test(input.installationId)
    || !isBoundedVisibleString(input.displayName, MAX_DISPLAY_NAME_LENGTH)
    || !isBoundedVisibleString(input.version, MAX_VERSION_LENGTH)
  ) {
    return null;
  }

  return {
    protocol: {
      name: MACHINE_PROTOCOL.NAME,
      major: MACHINE_PROTOCOL.MAJOR,
      minor: MACHINE_PROTOCOL.MINOR,
    },
    machine: {
      tailnetNodeId: input.tailscaleNodeId,
      installationId: input.installationId,
      displayName: input.displayName,
      origin,
    },
    wolfpack: { version: input.version },
    capabilities: MACHINE_CAPABILITIES,
  };
}

function localTailnetIdentity(status: unknown): LocalTailnetIdentity | null {
  if (!isRecord(status) || !isRecord(status.Self)) return null;
  const origin = canonicalTailnetOrigin(status.Self.DNSName);
  if (!origin || !isTailnetNodeId(status.Self.ID)) return null;
  return {
    tailscaleHostname: origin.slice("https://".length),
    tailscaleNodeId: status.Self.ID,
  };
}

function localMachineFacts(status: unknown): LocalTailnetMachineFacts | null {
  const identity = localTailnetIdentity(status);
  if (!identity || !isRecord(status) || !isRecord(status.Self) || !isBoundedVisibleString(status.Self.HostName, MAX_DISPLAY_NAME_LENGTH)) {
    return null;
  }
  return { ...identity, displayName: status.Self.HostName };
}

export function buildMachineHandshakeFromTailnetStatus(input: {
  readonly status: unknown;
  readonly installationId: string | undefined;
  readonly version: string | undefined;
}): MachineHandshake | null {
  const facts = localMachineFacts(input.status);
  if (!facts) return null;
  return buildMachineHandshake({ ...facts, installationId: input.installationId, version: input.version });
}

/** Returns bounded, local-Tailscale-derived candidate facts; it never probes a peer. */
export function enumerateTailnetCandidates(status: unknown): TailnetCandidateEnumeration {
  const self = localTailnetIdentity(status);
  if (!self || !isRecord(status) || !isRecord(status.Peer)) return { kind: "invalid-local-status" };

  const candidates = new Map<string, TailnetMachineCandidate>();
  for (const value of Object.values(status.Peer)) {
    if (!isRecord(value)) continue;
    const online = value.Online;
    if ((online !== true && online !== false) || !isTailnetNodeId(value.ID) || value.ID === self.tailscaleNodeId) continue;
    const origin = canonicalTailnetOrigin(value.DNSName);
    if (!origin || candidates.has(value.ID)) continue;
    candidates.set(value.ID, {
      hostname: origin.slice("https://".length),
      tailnetNodeId: value.ID,
      origin,
      online,
    });
    if (candidates.size === MAX_CANDIDATES) break;
  }
  return {
    kind: "valid",
    candidates: [...candidates.values()].sort((left, right) => left.tailnetNodeId.localeCompare(right.tailnetNodeId)),
  };
}

function hasRequiredCapabilities(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MACHINE_MAX_CAPABILITIES
    && value.every((capability) => typeof capability === "string" && capability.length > 0)
    && new Set(value).size === value.length
    && MACHINE_CAPABILITIES.every((capability) => value.includes(capability));
}

/** Strictly classifies a peer's handshake against the candidate facts that authorized its origin. */
export function classifyMachineHandshake(
  candidate: TailnetMachineCandidate,
  value: unknown,
): MachineHandshakeClassification {
  if (!isRecord(value) || !isRecord(value.protocol) || value.protocol.name !== MACHINE_PROTOCOL.NAME) {
    return { kind: "non-wolfpack" };
  }
  if (
    value.protocol.major !== MACHINE_PROTOCOL.MAJOR
    || !Number.isInteger(value.protocol.minor)
    || (value.protocol.minor as number) < 0
    || !isRecord(value.machine)
    || value.machine.tailnetNodeId !== candidate.tailnetNodeId
    || value.machine.origin !== candidate.origin
    || !isTailnetNodeId(value.machine.tailnetNodeId)
    || canonicalTailnetOrigin(candidate.hostname) !== candidate.origin
    || typeof value.machine.installationId !== "string"
    || !UUID_PATTERN.test(value.machine.installationId)
    || !isBoundedVisibleString(value.machine.displayName, MAX_DISPLAY_NAME_LENGTH)
    || !isRecord(value.wolfpack)
    || !isBoundedVisibleString(value.wolfpack.version, MAX_VERSION_LENGTH)
    || !hasRequiredCapabilities(value.capabilities)
  ) {
    return { kind: "incompatible" };
  }

  return {
    kind: "ready",
    handshake: {
      protocol: {
        name: MACHINE_PROTOCOL.NAME,
        major: MACHINE_PROTOCOL.MAJOR,
        minor: value.protocol.minor as number,
      },
      machine: {
        tailnetNodeId: value.machine.tailnetNodeId,
        installationId: value.machine.installationId,
        displayName: value.machine.displayName,
        origin: value.machine.origin,
      },
      wolfpack: { version: value.wolfpack.version },
      capabilities: value.capabilities.filter((capability): capability is MachineCapability => MACHINE_CAPABILITY_SET.has(capability)),
    },
  };
}
