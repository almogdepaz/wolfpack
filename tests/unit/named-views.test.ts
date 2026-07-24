import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NAMED_VIEW_SCHEMA_VERSION,
  MAX_NAMED_VIEW_NAME_CODE_POINTS,
  MAX_NAMED_VIEW_MEMBERS,
  isValidNamedViewMachineUrl,
  parseNamedViewInput,
  parseStoredNamedViewFile,
} from "../../src/named-views.ts";
import {
  NamedViewStore,
  NamedViewStoreConflictError,
  namedViewStorePath,
} from "../../src/server/named-view-store.ts";

process.env.WOLFPACK_TEST = "1";

function tmpDevDir(): string {
  const root = join(process.cwd(), ".wolfpack", "test-named-views");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "dev-"));
}

const baseMembers = [
  { machineUrl: "", sessionId: "local-session-id", sessionName: "local-session" },
  { machineUrl: "https://peer.tailnet.ts.net", sessionId: "peer-session-id", sessionName: "peer-session" },
];

describe("named view contract", () => {
  test("normalizes a bounded semantic view without terminal state", () => {
    const parsed = parseNamedViewInput({
      name: "  Release view  ",
      members: baseMembers,
      focused: { machineUrl: "https://peer.tailnet.ts.net", sessionId: "peer-session-id" },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toEqual({
      name: "Release view",
      members: baseMembers,
      focused: { machineUrl: "https://peer.tailnet.ts.net", sessionId: "peer-session-id" },
    });
    expect(JSON.stringify(parsed.value)).not.toContain("viewport");
    expect(JSON.stringify(parsed.value)).not.toContain("websocket");
  });

  test("enforces unicode name, member, machine url, and focus bounds", () => {
    expect(parseNamedViewInput({ name: "🚀".repeat(MAX_NAMED_VIEW_NAME_CODE_POINTS), members: [baseMembers[0]] }).ok)
      .toBe(true);
    expect(parseNamedViewInput({ name: "🚀".repeat(MAX_NAMED_VIEW_NAME_CODE_POINTS + 1), members: [baseMembers[0]] }).ok)
      .toBe(false);
    expect(parseNamedViewInput({ name: "bad\nname", members: [baseMembers[0]] }).ok).toBe(false);
    expect(parseNamedViewInput({ name: "empty", members: [] }).ok).toBe(false);
    expect(parseNamedViewInput({
      name: "too many",
      members: Array.from({ length: MAX_NAMED_VIEW_MEMBERS + 1 }, (_, index) => ({
        machineUrl: "",
        sessionId: `session-${index}`,
        sessionName: `session-${index}`,
      })),
    }).ok).toBe(false);
    expect(parseNamedViewInput({ name: "dupe", members: [baseMembers[0], { ...baseMembers[0], sessionName: "renamed" }] }).ok)
      .toBe(false);
    expect(parseNamedViewInput({
      name: "bad focus",
      members: [baseMembers[0]],
      focused: { machineUrl: "", sessionId: "missing" },
    }).ok).toBe(false);
  });

  test("rejects unknown fields and non-origin peer URLs", () => {
    expect(parseNamedViewInput({ name: "extra", members: [baseMembers[0]], layout: "grid" }).ok).toBe(false);
    expect(parseNamedViewInput({ name: "extra member", members: [{ ...baseMembers[0], alive: true }] }).ok).toBe(false);
    expect(isValidNamedViewMachineUrl("")).toBe(true);
    expect(isValidNamedViewMachineUrl("https://peer.tailnet.ts.net")).toBe(true);
    expect(isValidNamedViewMachineUrl("https://peer.tailnet.ts.net/path")).toBe(false);
    expect(isValidNamedViewMachineUrl("http://peer.tailnet.ts.net")).toBe(false);
    expect(isValidNamedViewMachineUrl("https://token@peer.tailnet.ts.net")).toBe(false);
  });

  test("fails closed on malformed stored records and future versions", () => {
    const valid = {
      schemaVersion: NAMED_VIEW_SCHEMA_VERSION,
      views: [{
        schemaVersion: NAMED_VIEW_SCHEMA_VERSION,
        id: "nv_11111111-1111-4111-8111-111111111111",
        name: "Release view",
        members: baseMembers,
        focused: { machineUrl: "", sessionId: "local-session-id" },
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:01.000Z",
      }],
    };
    expect(parseStoredNamedViewFile(valid).ok).toBe(true);
    expect(parseStoredNamedViewFile({ ...valid, schemaVersion: NAMED_VIEW_SCHEMA_VERSION + 1 }).ok).toBe(false);
    expect(parseStoredNamedViewFile({ ...valid, views: [{ ...valid.views[0], extra: true }] }).ok).toBe(false);
    expect(parseStoredNamedViewFile({ ...valid, views: [{ ...valid.views[0], focused: { machineUrl: "", sessionId: "missing" } }] }).ok)
      .toBe(false);
  });
});

describe("named view persistence store", () => {
  test("uses the wolfpack persistence boundary and treats missing file as empty", () => {
    const devDir = tmpDevDir();
    const store = new NamedViewStore({ devDir });

    expect(namedViewStorePath(devDir)).toBe(join(devDir, ".wolfpack", "named-views.json"));
    expect(store.list()).toEqual([]);
  });

  test("creates, updates, deletes, and preserves immutable fields", () => {
    const devDir = tmpDevDir();
    const store = new NamedViewStore({
      devDir,
      idGenerator: () => "nv_11111111-1111-4111-8111-111111111111",
    });

    const created = store.create({ name: "Release view", members: baseMembers }, new Date("2026-07-24T00:00:00.000Z"));
    expect(created).toMatchObject({
      schemaVersion: NAMED_VIEW_SCHEMA_VERSION,
      id: "nv_11111111-1111-4111-8111-111111111111",
      name: "Release view",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    });

    const updated = store.update({
      id: created.id,
      name: "release renamed",
      members: [baseMembers[1]],
      focused: { machineUrl: "https://peer.tailnet.ts.net", sessionId: "peer-session-id" },
    }, new Date("2026-07-24T00:00:01.000Z"));
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBe("2026-07-24T00:00:01.000Z");
    expect(updated.members).toEqual([baseMembers[1]]);

    expect(store.delete(created.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  test("rejects case-insensitive duplicate names", () => {
    const devDir = tmpDevDir();
    let count = 0;
    const store = new NamedViewStore({
      devDir,
      idGenerator: () => `nv_${++count}`,
    });

    store.create({ name: "Release", members: [baseMembers[0]] }, new Date("2026-07-24T00:00:00.000Z"));
    expect(() => store.create({ name: " release ", members: [baseMembers[1]] }, new Date("2026-07-24T00:00:01.000Z")))
      .toThrow(NamedViewStoreConflictError);
  });

  test("refuses to overwrite malformed persistence", () => {
    const devDir = tmpDevDir();
    const path = namedViewStorePath(devDir);
    mkdirSync(join(devDir, ".wolfpack"), { recursive: true });
    const malformed = "{not-json";
    writeFileSync(path, malformed);

    const store = new NamedViewStore({ devDir });
    expect(() => store.create({ name: "Release", members: [baseMembers[0]] })).toThrow("named view persistence");
    expect(readFileSync(path, "utf-8")).toBe(malformed);
  });

  test("classifies real filesystem write failures as named-view persistence writes", () => {
    const devDir = tmpDevDir();
    const wolfpackDir = join(devDir, ".wolfpack");
    mkdirSync(wolfpackDir, { recursive: true });
    chmodSync(wolfpackDir, 0o555);
    const store = new NamedViewStore({ devDir });

    try {
      expect(() => store.create({ name: "Release", members: [baseMembers[0]] }))
        .toThrow("named view persistence write failed");
      try {
        store.create({ name: "Release", members: [baseMembers[0]] });
        throw new Error("expected named-view write to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("NamedViewPersistenceWriteError");
      }
    } finally {
      chmodSync(wolfpackDir, 0o755);
    }
  });
});
