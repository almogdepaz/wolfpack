#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONTROL_API_SCHEMA_ARTIFACT,
  buildControlApiSchema,
} from "../src/control-api/schema.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT_FILE = join(ROOT, CONTROL_API_SCHEMA_ARTIFACT);

type JsonObject = Record<string, unknown>;

const SUPPORTED_SCHEMA_KEYS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "anyOf",
  "artifactPath",
  "auth",
  "binaryFrames",
  "breakingChanges",
  "compatibility",
  "const",
  "contentMediaType",
  "description",
  "direction",
  "enum",
  "errors",
  "generatedFrom",
  "http",
  "items",
  "operationId",
  "ownership",
  "pattern",
  "properties",
  "query",
  "request",
  "required",
  "response",
  "route",
  "schema",
  "stable",
  "title",
  "trustBoundaries",
  "type",
  "version",
  "websocket",
]);

const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSchemaNode(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSchemaNode(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key) && !/^[A-Za-z0-9_./ -]+$/.test(key)) {
      errors.push(`${path}: unsupported schema key ${JSON.stringify(key)}`);
    }
    if (key === "type" && (typeof child === "string" || Array.isArray(child))) {
      const types = Array.isArray(child) ? child : [child];
      for (const type of types) {
        if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
          errors.push(`${path}.type: unsupported field type ${JSON.stringify(type)}`);
        }
      }
    }
    validateSchemaNode(child, `${path}.${key}`, errors);
  }
}

function assertUnique(names: readonly string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) errors.push(`duplicate ${label}: ${name}`);
    seen.add(name);
  }
}

export function validateControlApiSchemaArtifact(schema: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(schema)) return ["schema artifact must be an object"];

  const defs = schema.$defs;
  if (!isObject(defs)) errors.push("$defs must be an object");
  else assertUnique(Object.keys(defs), "$defs name", errors);

  const http = schema.http;
  if (!isObject(http)) {
    errors.push("http must be an object");
  } else {
    assertUnique(Object.keys(http), "http operation id", errors);
    const routes = Object.values(http)
      .map((entry) => isObject(entry) && typeof entry.route === "string" ? entry.route : "")
      .filter(Boolean);
    assertUnique(routes, "http route", errors);
  }

  const wsPty = isObject(schema.websocket) ? schema.websocket["/ws/pty"] : undefined;
  const messages = isObject(wsPty) && isObject(wsPty.messages) ? wsPty.messages : undefined;
  if (!messages) errors.push("websocket./ws/pty.messages must be an object");
  else assertUnique(Object.keys(messages), "websocket message", errors);

  validateSchemaNode(schema, "$", errors);
  return errors;
}

export function generateControlApiSchemaText(): string {
  const schema = buildControlApiSchema();
  const errors = validateControlApiSchemaArtifact(schema);
  if (errors.length > 0) {
    throw new Error(`control api schema generation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (import.meta.main) {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, generateControlApiSchemaText());
  console.log(`generated ${CONTROL_API_SCHEMA_ARTIFACT}`);
}
