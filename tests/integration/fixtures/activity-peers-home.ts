// Private process fixture: the home server's peer discovery and journal reads, with its own config and test tailnet.
import { discoverActivityPeers } from "../../../src/server/activity-peers.ts";

const [root, maxBytes, repeat = "1"] = process.argv.slice(2);
if (!root || !maxBytes || process.env.WOLFPACK_TEST !== "1" || process.env.HOME !== root) throw new Error("private fixture required");
const readStatus = async () => JSON.parse(process.env.WOLFPACK_TAILSCALE_STATUS_JSON!);
for (let i = 1; i < Number(repeat); i++) await discoverActivityPeers(Date.now(), readStatus);
const { peers, failures } = await discoverActivityPeers(Date.now(), readStatus);
const reads = await Promise.all(peers.map(async peer => {
  try { return { origin: peer.origin, name: peer.name, page: await peer.get<{ rows: unknown[] }>("/api/activity?since=0&limit=10", Number(maxBytes)) }; }
  catch (error) { return { origin: peer.origin, name: peer.name, error: error instanceof Error ? error.message : String(error) }; }
}));
// Logs share stdout; the result is the last line.
process.stdout.write(`\n${JSON.stringify({ reads, failures })}\n`);
