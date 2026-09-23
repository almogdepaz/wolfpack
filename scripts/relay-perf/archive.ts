import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Core } from "./adapter.ts";
import { record } from "./measurement.ts";

// Structural APIs of the pinned external packages; all behavior stays in their production modules.
interface History {
  getEntries(): readonly unknown[];
  getSessionFile(): string;
  appendMessage(message: unknown): void;
  appendCustomEntry(type: string, value: unknown): void;
  appendCustomMessageEntry(type: string, content: string, display: boolean, details: unknown): void;
}
interface ArchivePi {
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }): void;
  appendEntry(type: string, value: unknown): void;
}
interface InboxModule {
  deliverTaskInbox(pi: ArchivePi, core: Core, context: { isIdle(): boolean; hasPendingMessages(): boolean; sessionManager: History }): Promise<unknown>;
}
interface HistoryModule { SessionManager: { create(cwd: string, directory: string): History; open(path: string): History } }
export interface Archive {
  readonly info: { readonly events: number; readonly entries: number; readonly bytes: number; readonly sdkVersion: string; readonly sdkSha256: string };
  readonly writes: { readonly at: number; readonly type: string; readonly details: unknown }[];
  poll(core: Core): Promise<void>;
  entries(): number;
}

/** Real Pi history storage + real inbox helper. Wake insertion is synchronous; no model/TUI runs. */
export async function createArchive(source: string, root: string, events: number): Promise<Archive> {
  if (!Number.isSafeInteger(events) || events < 0 || events > 10_000) throw new Error("invalid archive count");
  const sdkRoot = join(source, "node_modules/@earendil-works/pi-coding-agent");
  const sdkFile = join(sdkRoot, "dist/core/session-manager.js");
  const sdk: unknown = await import(pathToFileURL(sdkFile).href);
  const inbox: unknown = await import(pathToFileURL(join(source, "src/task-inbox.ts")).href);
  if (typeof record(inbox).deliverTaskInbox !== "function" || typeof record(sdk).SessionManager !== "function") throw new Error("archive exports unavailable");
  const { SessionManager } = sdk as HistoryModule;
  let history = SessionManager.create(root, root);
  // A synthetic pre-existing assistant entry makes SessionManager persist subsequent custom entries.
  history.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "benchmark", model: "none",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now() });
  for (let index = 0; index < events; index++) {
    const taskId = randomUUID(), eventId = randomUUID();
    history.appendCustomMessageEntry("pi-tasks-event", "archived fixture completion", true, { taskId, eventId,
      event: { taskId, eventId, type: "task.completed", sequence: "2", occurredAt: 1,
        source: { relay: "archive", id: "source" }, target: { relay: "archive", id: "target" }, payload: { summary: "synthetic historical evidence" } } });
  }
  history = SessionManager.open(history.getSessionFile()); // Exercise the real persisted-entry loader before measurement.
  const writes: { at: number; type: string; details: unknown }[] = [];
  const pi: ArchivePi = {
    sendMessage(message) {
      history.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      writes.push({ at: Date.now(), type: message.customType, details: message.details });
    },
    appendEntry(type, value) { history.appendCustomEntry(type, value); },
  };
  const sdkVersion = record(JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"))).version;
  if (typeof sdkVersion !== "string") throw new Error("missing SDK version");
  return {
    info: { events, entries: history.getEntries().length, bytes: statSync(history.getSessionFile()).size,
      sdkVersion, sdkSha256: createHash("sha256").update(readFileSync(sdkFile)).digest("hex") },
    writes, entries: () => history.getEntries().length,
    async poll(core) {
      const failure = await (inbox as InboxModule).deliverTaskInbox(pi, core, { isIdle: () => true, hasPendingMessages: () => false, sessionManager: history });
      if (failure) throw failure;
    },
  };
}
