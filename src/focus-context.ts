/**
 * The agent-context extension's per-session document (`agent-context/context`, wire schema v3), reduced to what a
 * focus card shows. The document is agent-authored data: only string fields are kept, nothing is interpreted as markup.
 */
export const AGENT_CONTEXT_EXTENSION = "agent-context";
export const AGENT_CONTEXT_DOCUMENT_PATH = "/extensions/documents/agent-context/context";
export type AgentContextSummary =
  | { kind: "unsupported"; version: string }
  | {
    kind: "v3";
    goal?: string;
    now?: string;
    /** Every item, with its stable v3 id (a later round attaches an answer per item). */
    needsYou: { id: string; text: string }[];
    nextSteps: { text: string; owner?: "agent" | "user" }[];
    needToKnow: string[];
    freshness?: string;
    updatedAt?: string;
  };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const items = (v: unknown) => (Array.isArray(v) ? v : []).filter((i): i is { id: string; text: string } & Record<string, unknown> => object(i) && str(i.id) && str(i.text));
export function summarizeAgentContext(doc: unknown): AgentContextSummary | null {
  if (!object(doc)) return null;
  if (doc.schemaVersion !== 3) {
    const version = doc.schemaVersion;
    return { kind: "unsupported", version: Number.isSafeInteger(version) ? String(version) : "?" };
  }
  const now = object(doc.now) && str(doc.now.text) ? doc.now.text : undefined;
  return {
    kind: "v3",
    ...(str(doc.goal) && { goal: doc.goal }),
    ...(now && { now }),
    needsYou: items(doc.needsYou).map(i => ({ id: i.id, text: i.text })),
    nextSteps: (Array.isArray(doc.nextSteps) ? doc.nextSteps : []).filter(i => object(i) && str(i.text)).slice(0, 3)
      .map(i => ({ text: i.text as string, ...((i.owner === "agent" || i.owner === "user") && { owner: i.owner as "agent" | "user" }) })),
    needToKnow: items(doc.needToKnow).slice(0, 3).map(i => i.text),
    ...((doc.freshness === "reviewed" || doc.freshness === "unreviewed" || doc.freshness === "missed") && { freshness: doc.freshness }),
    ...(str(doc.updatedAt) && Number.isFinite(Date.parse(doc.updatedAt)) && { updatedAt: doc.updatedAt }),
  };
}
/** `GET /api/extensions`: the panel's documents are readable only while it is installed, enabled and not in safe mode. */
export function agentContextEnabled(catalog: unknown): boolean {
  return object(catalog) && catalog.safeMode !== true && Array.isArray(catalog.installations)
    && catalog.installations.some(i => object(i) && i.extensionId === AGENT_CONTEXT_EXTENSION && i.enabled === true);
}
/**
 * The machine answered that the panel's documents are not there: an older build without the extensions api (404),
 * the extension not installed (404 `NOT_INSTALLED`) or disabled (`DISABLED`). Cached like a disabled catalog;
 * anything else (transport, auth, store errors) is retried on the next poll.
 */
export function extensionUnavailable(error: unknown): boolean {
  if (!object(error)) return false;
  const code = object(error.data) && object(error.data.error) ? error.data.error.code : undefined;
  return error.status === 404 || code === "NOT_INSTALLED" || code === "DISABLED";
}
