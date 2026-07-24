import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  MAX_NAMED_VIEWS,
  NAMED_VIEW_INVALID_REQUEST,
  NAMED_VIEW_SCHEMA_VERSION,
  isStoredNamedViewFile,
  isValidNamedViewId,
  namedViewNameKey,
  parseNamedViewInput,
} from "../named-views.js";
import type {
  NamedViewInput,
  NamedViewRecord,
  NamedViewStoreFile,
} from "../named-views.js";
import { DEV_DIR } from "./dev-dir.js";
import { readValidatedJsonFile } from "./persistence.js";

export const NAMED_VIEW_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  DUPLICATE_NAME: "DUPLICATE_NAME",
  NOT_FOUND: "NOT_FOUND",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  PERSISTENCE_UNAVAILABLE: "PERSISTENCE_UNAVAILABLE",
} as const;

export type NamedViewErrorCode = (typeof NAMED_VIEW_ERROR)[keyof typeof NAMED_VIEW_ERROR];

export class NamedViewStoreConflictError extends Error {
  readonly code: typeof NAMED_VIEW_ERROR.DUPLICATE_NAME;

  constructor() {
    super("named view name already exists");
    this.name = "NamedViewStoreConflictError";
    this.code = NAMED_VIEW_ERROR.DUPLICATE_NAME;
  }
}

export class NamedViewStoreLimitError extends Error {
  readonly code: typeof NAMED_VIEW_ERROR.LIMIT_EXCEEDED;

  constructor() {
    super("named view limit reached");
    this.name = "NamedViewStoreLimitError";
    this.code = NAMED_VIEW_ERROR.LIMIT_EXCEEDED;
  }
}

export class NamedViewStoreNotFoundError extends Error {
  readonly code: typeof NAMED_VIEW_ERROR.NOT_FOUND;

  constructor() {
    super("named view not found");
    this.name = "NamedViewStoreNotFoundError";
    this.code = NAMED_VIEW_ERROR.NOT_FOUND;
  }
}

export class NamedViewPersistenceWriteError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`named view persistence write failed: ${path}`, { cause });
    this.name = "NamedViewPersistenceWriteError";
    this.path = path;
  }
}

export interface NamedViewStoreOptions {
  readonly devDir?: string;
  readonly path?: string;
  readonly idGenerator?: () => string;
}

export interface NamedViewUpdateInput extends NamedViewInput {
  readonly id: string;
}

export function namedViewStorePath(devDir?: string): string {
  if (devDir !== undefined) return join(devDir, ".wolfpack", "named-views.json");
  if (process.env.WOLFPACK_NAMED_VIEW_PATH) return process.env.WOLFPACK_NAMED_VIEW_PATH;
  if (process.env.WOLFPACK_TEST) return join(process.cwd(), ".wolfpack", `named-views-test-${process.pid}.json`);
  return join(DEV_DIR, ".wolfpack", "named-views.json");
}

export function parseNamedViewUpdateInput(value: unknown): NamedViewUpdateInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!isValidNamedViewId(obj.id)) return null;
  const parsed = parseNamedViewInput({
    name: obj.name,
    members: obj.members,
    ...(obj.focused !== undefined ? { focused: obj.focused } : {}),
  });
  if (!parsed.ok || !hasOnlyUpdateKeys(obj)) return null;
  return { id: obj.id, ...parsed.value };
}

export function parseNamedViewDeleteInput(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== 1 || !isValidNamedViewId(obj.id)) return null;
  return obj.id;
}

export class NamedViewStore {
  readonly path: string;
  private readonly idGenerator: () => string;

  constructor(options: NamedViewStoreOptions = {}) {
    this.path = options.path ?? namedViewStorePath(options.devDir);
    this.idGenerator = options.idGenerator ?? (() => `nv_${randomUUID()}`);
  }

  list(): NamedViewRecord[] {
    return [...this.read().views];
  }

  create(input: NamedViewInput, now: Date = new Date()): NamedViewRecord {
    const parsed = parseNamedViewInput(input);
    if (!parsed.ok) throw new Error(NAMED_VIEW_INVALID_REQUEST);
    const file = this.read();
    if (file.views.length >= MAX_NAMED_VIEWS) throw new NamedViewStoreLimitError();
    if (hasDuplicateName(file.views, parsed.value.name)) throw new NamedViewStoreConflictError();
    const timestamp = now.toISOString();
    const view: NamedViewRecord = {
      schemaVersion: NAMED_VIEW_SCHEMA_VERSION,
      id: this.idGenerator(),
      ...parsed.value,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!isValidNamedViewId(view.id)) throw new Error("generated named view id is invalid");
    this.write({ schemaVersion: NAMED_VIEW_SCHEMA_VERSION, views: [...file.views, view] });
    return view;
  }

  update(input: NamedViewUpdateInput, now: Date = new Date()): NamedViewRecord {
    const parsed = parseNamedViewUpdateInput(input);
    if (!parsed) throw new Error(NAMED_VIEW_INVALID_REQUEST);
    const file = this.read();
    const existingIndex = file.views.findIndex((view) => view.id === parsed.id);
    if (existingIndex < 0) throw new NamedViewStoreNotFoundError();
    const existing = file.views[existingIndex];
    if (!existing) throw new NamedViewStoreNotFoundError();
    if (hasDuplicateName(file.views, parsed.name, parsed.id)) throw new NamedViewStoreConflictError();
    const updated: NamedViewRecord = {
      schemaVersion: NAMED_VIEW_SCHEMA_VERSION,
      id: existing.id,
      name: parsed.name,
      members: parsed.members,
      ...(parsed.focused ? { focused: parsed.focused } : {}),
      createdAt: existing.createdAt,
      updatedAt: nextTimestamp(now, existing.updatedAt),
    };
    const views = [...file.views];
    views[existingIndex] = updated;
    this.write({ schemaVersion: NAMED_VIEW_SCHEMA_VERSION, views });
    return updated;
  }

  delete(id: string): boolean {
    if (!isValidNamedViewId(id)) throw new Error(NAMED_VIEW_INVALID_REQUEST);
    const file = this.read();
    const next = file.views.filter((view) => view.id !== id);
    if (next.length === file.views.length) return false;
    this.write({ schemaVersion: NAMED_VIEW_SCHEMA_VERSION, views: next });
    return true;
  }

  deleteAll(): void {
    rmSync(this.path, { force: true });
  }

  private read(): NamedViewStoreFile {
    return readValidatedJsonFile(this.path, "named view", isStoredNamedViewFile) ?? emptyStore();
  }

  private write(file: NamedViewStoreFile): void {
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(tmp, this.path);
    } catch (error: unknown) {
      try { rmSync(tmp, { force: true }); } catch { /* best-effort temp cleanup after failed atomic write */ }
      throw new NamedViewPersistenceWriteError(this.path, error);
    }
  }
}

function emptyStore(): NamedViewStoreFile {
  return { schemaVersion: NAMED_VIEW_SCHEMA_VERSION, views: [] };
}

function hasOnlyUpdateKeys(obj: Record<string, unknown>): boolean {
  const keys = new Set(["id", "name", "members", "focused"]);
  return Object.keys(obj).every((key) => keys.has(key));
}

function hasDuplicateName(views: readonly NamedViewRecord[], name: string, exceptId?: string): boolean {
  const target = namedViewNameKey(name);
  return views.some((view) => view.id !== exceptId && namedViewNameKey(view.name) === target);
}

function nextTimestamp(now: Date, previousIso: string): string {
  const previousMs = Date.parse(previousIso);
  const nowMs = now.getTime();
  if (!Number.isFinite(previousMs) || nowMs > previousMs) return now.toISOString();
  return new Date(previousMs + 1).toISOString();
}

let singleton: NamedViewStore | null = null;

export function getNamedViewStore(): NamedViewStore {
  if (!singleton) singleton = new NamedViewStore();
  return singleton;
}

export function __resetNamedViewStoreForTest(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetNamedViewStoreForTest() is test-only");
  singleton = null;
}

export function __namedViewStoreFileExistsForTest(devDir: string): boolean {
  if (!process.env.WOLFPACK_TEST) throw new Error("__namedViewStoreFileExistsForTest() is test-only");
  return existsSync(namedViewStorePath(devDir));
}
