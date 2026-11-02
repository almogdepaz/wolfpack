import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOrganizationService } from "../../src/server/session-organization.ts";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "organization-")); roots.push(root); return { root, service: new SessionOrganizationService({ root }), path: join(root, `${ID}.json`) }; }

test("missing defaults, normalization, UUID isolation, private durable restart, clear tombstone and no-op", () => {
  const { root, service, path } = fixture();
  expect(service.read(ID)).toEqual({ group: null, tags: [], revision: 0 });
  const saved = service.update(ID, { expectedRevision: 0, group: " ops ", tags: ["Cafe\u0301", "CAFÉ", "urgent"] });
  expect(saved).toEqual({ group: "ops", tags: ["Café", "urgent"], revision: 1 });
  expect(service.read(OTHER).revision).toBe(0);
  expect(new SessionOrganizationService({ root }).read(ID)).toEqual(saved);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(service.update(ID, { expectedRevision: 1, group: "ops" })).toEqual(saved);
  expect(service.update(ID, { expectedRevision: 1, group: null, tags: [] })).toEqual({ group: null, tags: [], revision: 2 });
  expect(() => service.update(ID, { expectedRevision: 1, tags: ["stale"] })).toThrow("revision conflict");
});

test("strict bounds, unknown fields, safe filenames, controls and Unicode", () => {
  const { service } = fixture();
  for (const update of [
    { expectedRevision: -1, group: "a" }, { expectedRevision: 0 },
    { expectedRevision: 0, group: " " }, { expectedRevision: 0, group: "x\n" },
    { expectedRevision: 0, group: "a".repeat(65) }, { expectedRevision: 0, group: "\ud800" },
    { expectedRevision: 0, tags: Array.from({ length: 17 }, (_, i) => String(i)) },
    { expectedRevision: 0, tags: ["a"], unknown: true },
  ]) expect(() => service.update(ID, update)).toThrow();
  for (const id of ["../bad", "live", "AAAAAAAA-1111-4111-8111-111111111111", ""]) expect(() => service.read(id)).toThrow();
  expect(service.update(ID, { expectedRevision: 0, group: "😀".repeat(64) }).group).toBe("😀".repeat(64));
});

test("malformed and unreadable records are not missing and never overwritten", () => {
  const { service, path } = fixture();
  writeFileSync(path, "broken");
  expect(() => service.read(ID)).toThrow("malformed");
  expect(() => service.update(ID, { expectedRevision: 0, tags: ["x"] })).toThrow();
  expect(readFileSync(path, "utf8")).toBe("broken");
  rmSync(path); mkdirSync(path);
  expect(() => service.read(ID)).toThrow("unreadable");
});

test("write failure preserves previous bytes and canonical state", () => {
  const { service, root, path } = fixture();
  service.update(ID, { expectedRevision: 0, tags: ["old"] });
  const bytes = readFileSync(path, "utf8");
  const failing = new SessionOrganizationService({ root, write: () => { throw new Error("disk full"); } });
  expect(() => failing.update(ID, { expectedRevision: 1, tags: ["new"] })).toThrow("disk full");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(failing.read(ID)).toEqual(service.read(ID));
});
