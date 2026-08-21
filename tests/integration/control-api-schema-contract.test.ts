import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTROL_API_SCHEMA_ARTIFACT } from "../../src/control-api/schema.ts";
import {
  isJsonObject as isObject,
  validateControlApiSchemaValue as validate,
} from "../control-api-schema-validator.ts";
import type { JsonObject } from "../control-api-schema-validator.ts";

process.env.WOLFPACK_TEST = "1";
delete process.env.WOLFPACK_JWT_SECRET;

const rawTmpDir = join(tmpdir(), `wolfpack-schema-contract-${process.pid}`);
mkdirSync(rawTmpDir, { recursive: true });
const TEST_DEV_DIR = realpathSync(rawTmpDir);
process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;
process.env.WOLFPACK_SETTINGS_PATH = join(TEST_DEV_DIR, "bridge-settings.json");
process.env.WOLFPACK_MACHINE_ID_PATH = join(TEST_DEV_DIR, "machine-id");
const priorTailscaleStatus = process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: {
    ID: "n-schema-test",
    DNSName: "schema-test.example.ts.net.",
    HostName: "schema-test",
  },
  Peer: {
    "n-schema-offline": {
      ID: "n-schema-offline",
      DNSName: "schema-offline.example.ts.net.",
      Online: false,
    },
  },
});

const { __resetJwtAuthConfig, __setDevDir } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
__resetJwtAuthConfig();
__setDevDir(TEST_DEV_DIR);

const mockBackend = new MockBackend({
  sessions: ["wolf-1"],
  capturePane: async () => "ready\n",
});
const originalListIdentities = mockBackend.listIdentities.bind(mockBackend);
mockBackend.listIdentities = async () => {
  const identities = await originalListIdentities();
  const parent = identities["wolf-1"];
  if (!parent) return identities;
  return { ...identities, "wolf-1": { ...parent, agentKind: "pi" } };
};
__setTestBackend(mockBackend);

const { createServerInstance } = await import("../../src/server/index.ts") as any;
const { server } = createServerInstance();

let base = "";
const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf-8")) as JsonObject;

function httpOperation(operationId: string): JsonObject {
  const http = artifact.http;
  const operation = isObject(http) ? http[operationId] : undefined;
  if (!isObject(operation)) throw new Error(`missing operation ${operationId}`);
  return operation;
}

function httpRequest(operationId: string): JsonObject {
  const request = httpOperation(operationId).request;
  if (!isObject(request)) throw new Error(`missing request for ${operationId}`);
  return request;
}

function httpResponse(operationId: string): JsonObject {
  const response = httpOperation(operationId).response;
  if (!isObject(response)) throw new Error(`missing response for ${operationId}`);
  return response;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`);
  expect(res.status).toBe(200);
  return await res.json();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return await res.json();
}

beforeAll(async () => {
  mkdirSync(join(TEST_DEV_DIR, "wolfpack"), { recursive: true });
  await new Promise<void>((resolve) => {
    (server as Server).listen(0, "127.0.0.1", () => {
      const port = ((server as Server).address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  (server as Server).close();
  if (priorTailscaleStatus === undefined) delete process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
  else process.env.WOLFPACK_TAILSCALE_STATUS_JSON = priorTailscaleStatus;
  rmSync(TEST_DEV_DIR, { recursive: true, force: true });
});

describe("control api generated schema against runtime responses", () => {
  test("validates representative real HTTP responses", async () => {
    const samples: Array<[string, unknown]> = [
      ["getInfo", await getJson("/api/info")],
      ["getMachineHandshake", await getJson("/api/machine")],
      ["discoverTailnetCandidates", await getJson("/api/tailnet/v1/candidates")],
      ["discoverPeers", await getJson("/api/discover")],
      ["listSessions", await getJson("/api/sessions")],
      ["getSettings", await getJson("/api/settings")],
      ["listProviderReadiness", await getJson("/api/providers")],
      ["createTopLevelSession", await postJson("/api/session-create", {
        project: "wolfpack",
        harness: "pi",
        initialPrompt: "execute the plan",
      })],
      ["listSessionStatuses", await getJson("/api/session-control/list")],
      ["getSessionStatus", await getJson(
        `/api/session-control/status?session=${encodeURIComponent("mock:wolfpack")}`,
      )],
      ["openSession", await postJson("/api/session-open", {
        project: "wolfpack",
        parentSession: "wolf-1",
      })],
    ];

    for (const [operationId, payload] of samples) {
      expect(validate(httpResponse(operationId), payload, artifact), operationId).toEqual([]);
    }
  });

  const invalidRequestCases = [
    {
      name: "rejects unknown create properties",
      operationId: "createSession",
      path: "/api/create",
      body: { projectDir: join(TEST_DEV_DIR, "missing-project"), unexpected: true },
    },
    {
      name: "rejects unknown settings properties",
      operationId: "updateSettings",
      path: "/api/settings",
      body: { unexpected: true },
    },
    {
      name: "rejects unknown setCmdEnabled properties",
      operationId: "updateSettings",
      path: "/api/settings",
      body: { setCmdEnabled: { cmd: "shell", enabled: true, unexpected: true } },
    },
    {
      name: "rejects fractional resize dimensions",
      operationId: "resizeSession",
      path: "/api/resize",
      body: { session: "wolf-1", cols: 80.5, rows: 24.5 },
    },
    {
      name: "rejects unknown resize properties",
      operationId: "resizeSession",
      path: "/api/resize",
      body: { session: "wolf-1", cols: 80, rows: 24, unexpected: true },
    },
  ] as const;

  for (const invalidRequest of invalidRequestCases) {
    test(invalidRequest.name, async () => {
      expect(
        validate(httpRequest(invalidRequest.operationId), invalidRequest.body, artifact),
        `${invalidRequest.operationId} schema`,
      ).not.toEqual([]);
      const response = await fetch(`${base}${invalidRequest.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalidRequest.body),
      });
      expect(response.status, `${invalidRequest.path} runtime`).toBe(400);
    });
  }
});
