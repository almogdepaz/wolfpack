const MACHINE_PROTOCOL_NAME = "wolfpack-machine";
const MACHINE_PROTOCOL_MAJOR = 1;
const REQUIRED_CAPABILITIES = new Set(["sessions", "terminal-websocket", "push-subscription"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TailnetPeerCandidate {
  readonly hostname: string;
  readonly nodeId: string;
  readonly url: string;
}

export type TailnetPeerProbe =
  | { readonly status: "unreachable" }
  | { readonly status: number; readonly body: unknown };

export type TailnetPeerDiscovery =
  | (TailnetPeerCandidate & { readonly status: "offline" | "non-wolfpack" | "incompatible" })
  | (TailnetPeerCandidate & { readonly status: "ready"; readonly name: string; readonly version: string; readonly peerId: string });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredCapabilities(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((capability) => typeof capability === "string")) return false;
  return Array.from(REQUIRED_CAPABILITIES).every((capability) => value.includes(capability));
}

export function classifyTailnetPeerHandshake(
  candidate: TailnetPeerCandidate,
  probe: TailnetPeerProbe,
): TailnetPeerDiscovery {
  if (probe.status === "unreachable") return { status: "offline", ...candidate };
  if (probe.status === 404) return { status: "non-wolfpack", ...candidate };
  if (!isRecord(probe.body)) return { status: "non-wolfpack", ...candidate };

  const protocol = isRecord(probe.body.protocol) ? probe.body.protocol : null;
  if (protocol?.name !== MACHINE_PROTOCOL_NAME) return { status: "non-wolfpack", ...candidate };
  const machine = isRecord(probe.body.machine) ? probe.body.machine : null;
  const wolfpack = isRecord(probe.body.wolfpack) ? probe.body.wolfpack : null;
  if (
    protocol.major !== MACHINE_PROTOCOL_MAJOR
    || machine?.tailnetNodeId !== candidate.nodeId
    || machine.url !== candidate.url
    || typeof machine.installationId !== "string"
    || !UUID_PATTERN.test(machine.installationId)
    || typeof machine.displayName !== "string"
    || !machine.displayName
    || /[\x00-\x1f\x7f-\x9f]/.test(machine.displayName)
    || typeof wolfpack?.version !== "string"
    || !hasRequiredCapabilities(probe.body.capabilities)
  ) {
    return { status: "incompatible", ...candidate };
  }

  return {
    status: "ready",
    ...candidate,
    name: machine.displayName,
    version: wolfpack.version,
    peerId: `${candidate.nodeId}:${machine.installationId}`,
  };
}
