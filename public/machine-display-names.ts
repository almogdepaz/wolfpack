import { isStableMachineIdentity } from "../src/tailnet-peer-registry";

const NAME_TTL_MS = 5 * 60_000;
const MAX_NAMES = 128;

/** Display metadata only: never supplies an origin, identity, version or readiness. */
export class MachineDisplayNames {
  private readonly names = new Map<string, { name: string | undefined; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  get(identity: string): string | undefined { return this.names.get(identity)?.name; }

  async resolve(identity: string, read: () => Promise<unknown>, isCurrent: () => boolean): Promise<string | undefined> {
    if (!isStableMachineIdentity(identity)) return undefined;
    const cached = this.names.get(identity);
    if (cached && cached.expires > this.now()) return cached.name;
    let name = cached?.name;
    try {
      const info = await read();
      const value = info && typeof info === "object" ? info as { machineId?: unknown; name?: unknown } : {};
      name = typeof value.machineId === "string" && value.machineId.toLowerCase() === identity.slice(-36).toLowerCase()
        && typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 255
        && !/[\u0000-\u001f\u007f]/.test(value.name) ? value.name.trim() : undefined;
    } catch { /* Optional metadata failure never takes a verified peer offline. */ }
    if (!isCurrent()) return undefined;
    // Bound successful and failed lookups alike, avoiding a request on every poll.
    this.names.delete(identity);
    if (this.names.size >= MAX_NAMES) this.names.delete(this.names.keys().next().value!);
    this.names.set(identity, { name, expires: this.now() + NAME_TTL_MS });
    return name;
  }
}
