import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTROL_API_SCHEMA_ARTIFACT } from "../../src/control-api/schema.ts";

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

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(schema: JsonObject, root: JsonObject): JsonObject {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported ref ${ref}`);
  const defs = root.$defs;
  const name = ref.slice(prefix.length);
  if (!isObject(defs) || !isObject(defs[name])) throw new Error(`missing ref ${ref}`);
  return defs[name] as JsonObject;
}

function validate(schema: unknown, value: unknown, root: JsonObject, path = "$."): string[] {
  if (!isObject(schema)) return [];
  const resolved = resolveRef(schema, root);
  if (resolved !== schema) return validate(resolved, value, root, path);

  if (Array.isArray(resolved.anyOf)) {
    const variants = resolved.anyOf.map((candidate) => validate(candidate, value, root, path));
    if (!variants.some((errors) => errors.length === 0)) {
      return [`${path} did not match anyOf: ${variants.map((errors) => errors.join(", ")).join(" | ")}`];
    }
  }

  if ("const" in resolved && value !== resolved.const) return [`${path} expected const ${JSON.stringify(resolved.const)}`];
  if (Array.isArray(resolved.enum) && !resolved.enum.some((candidate) => candidate === value)) {
    return [`${path} expected one of ${JSON.stringify(resolved.enum)}`];
  }

  if (typeof resolved.type === "string") {
    if (resolved.type === "object" && !isObject(value)) return [`${path} expected object`];
    if (resolved.type === "array" && !Array.isArray(value)) return [`${path} expected array`];
    if (resolved.type === "string" && typeof value !== "string") return [`${path} expected string`];
    if (resolved.type === "number" && typeof value !== "number") return [`${path} expected number`];
    if (resolved.type === "integer" && !Number.isInteger(value)) return [`${path} expected integer`];
    if (resolved.type === "boolean" && typeof value !== "boolean") return [`${path} expected boolean`];
    if (resolved.type === "null" && value !== null) return [`${path} expected null`];
  }

  if (typeof value === "string" && typeof resolved.pattern === "string" && !(new RegExp(resolved.pattern).test(value))) {
    return [`${path} failed pattern ${resolved.pattern}`];
  }

  if (Array.isArray(value) && isObject(resolved.items)) {
    return value.flatMap((item, index) => validate(resolved.items, item, root, `${path}[${index}]`));
  }

  if (isObject(value)) {
    const required = Array.isArray(resolved.required) ? resolved.required : [];
    const errors: string[] = [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key} is required`);
    }
    if (isObject(resolved.properties)) {
      for (const [key, child] of Object.entries(resolved.properties)) {
        if (key in value) errors.push(...validate(child, value[key], root, `${path}.${key}`));
      }
      if (resolved.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in resolved.properties)) errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
    return errors;
  }

  return [];
}

function httpResponse(operationId: string): JsonObject {
  const http = artifact.http;
  const operation = isObject(http) ? http[operationId] : undefined;
  if (!isObject(operation) || !isObject(operation.response)) throw new Error(`missing operation ${operationId}`);
  return operation.response;
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
});
