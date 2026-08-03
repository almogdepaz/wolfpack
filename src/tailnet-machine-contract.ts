const MACHINE_PROTOCOL = {
  NAME: "wolfpack-machine",
  MAJOR: 1,
  MINOR: 0,
} as const;

const MACHINE_CAPABILITIES = [
  "sessions",
  "terminal-websocket",
  "push-subscription",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAILNET_NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export interface TailnetMachineHandshakeInput {
  readonly tailscaleHostname: string | undefined;
  readonly tailscaleNodeId: string | undefined;
  readonly installationId: string | undefined;
  readonly displayName: string;
  readonly version: string;
}

export interface TailnetMachineHandshake {
  readonly protocol: {
    readonly name: typeof MACHINE_PROTOCOL.NAME;
    readonly major: typeof MACHINE_PROTOCOL.MAJOR;
    readonly minor: typeof MACHINE_PROTOCOL.MINOR;
  };
  readonly machine: {
    readonly tailnetNodeId: string;
    readonly installationId: string;
    readonly displayName: string;
    readonly url: string;
  };
  readonly wolfpack: { readonly version: string };
  readonly capabilities: readonly (typeof MACHINE_CAPABILITIES)[number][];
}

function isCanonicalTailnetHostname(value: string): boolean {
  try {
    const url = new URL(`https://${value}`);
    return url.origin === `https://${value}` && url.hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}

export function buildTailnetMachineHandshake(
  input: TailnetMachineHandshakeInput,
): TailnetMachineHandshake | null {
  const { tailscaleHostname, tailscaleNodeId, installationId, displayName, version } = input;
  if (!tailscaleHostname || !isCanonicalTailnetHostname(tailscaleHostname)) return null;
  if (!tailscaleNodeId || !TAILNET_NODE_ID_PATTERN.test(tailscaleNodeId)) return null;
  if (!installationId || !UUID_PATTERN.test(installationId)) return null;
  if (!displayName || /[\x00-\x1f\x7f-\x9f]/.test(displayName)) return null;

  return {
    protocol: {
      name: MACHINE_PROTOCOL.NAME,
      major: MACHINE_PROTOCOL.MAJOR,
      minor: MACHINE_PROTOCOL.MINOR,
    },
    machine: {
      tailnetNodeId: tailscaleNodeId,
      installationId,
      displayName,
      url: `https://${tailscaleHostname}`,
    },
    wolfpack: { version },
    capabilities: MACHINE_CAPABILITIES,
  };
}
