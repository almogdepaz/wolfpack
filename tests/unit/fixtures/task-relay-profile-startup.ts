import assert from "node:assert/strict";
import { createTaskRelayGateway, getTaskRelayProfile } from "../../../src/task-relay/gateway.ts";
import { hasRelayWorkerOwners } from "../../../src/task-relay/worker-client.ts";

assert.equal(hasRelayWorkerOwners(), false);
assert.throws(() => getTaskRelayProfile(), /unsupported task relay profile/);
assert.throws(() => createTaskRelayGateway({ root: process.env.WOLFPACK_TASK_RELAY_ROOT! }), /unsupported task relay profile/);
assert.equal(hasRelayWorkerOwners(), false);
