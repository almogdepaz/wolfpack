import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushService, type PushServiceOptions } from "../../../src/server/push.ts";

/** Each fixture owns real services and storage; only external dependencies are mutable. */
export function createPushFixture(directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), "wolfpack-push-service-"));
  const dependencies: {
    sender: PushServiceOptions["sessionPushSender"] | null;
    now: (() => number) | undefined;
  } = { sender: null, now: undefined };
  const create = () => createPushService({
    directory: root,
    now: () => (dependencies.now ?? Date.now)(),
    get sessionPushSender() { return dependencies.sender ?? undefined; },
  });
  let service = create();
  return {
    dependencies,
    get service() { return service; },
    reset() { service.dispose(); dependencies.sender = null; dependencies.now = undefined; service = create(); },
    close() { service.dispose(); if (directory === undefined) rmSync(root, { recursive: true, force: true }); },
  };
}
