import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const OWNED_HOME_PREFIX = "wolfpack-e2e-server-";
const OWNERSHIP_MARKER = ".wolfpack-e2e-owner";

export interface OwnedTestServerHome {
  readonly path: string;
  readonly token: string;
}

export function createOwnedTestServerHome(): OwnedTestServerHome {
  const path = mkdtempSync(join(tmpdir(), OWNED_HOME_PREFIX));
  const token = randomUUID();
  writeFileSync(join(path, OWNERSHIP_MARKER), token, { flag: "wx", mode: 0o600 });
  return { path, token };
}

export function assertOwnedTestServerHome(home: OwnedTestServerHome): void {
  if (!home.path || !home.token || !existsSync(home.path)) {
    throw new Error("missing owned E2E test-server home");
  }
  const stat = lstatSync(home.path);
  const canonicalHome = realpathSync(home.path);
  const canonicalTemp = realpathSync(tmpdir());
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || dirname(canonicalHome) !== canonicalTemp
    || !basename(canonicalHome).startsWith(OWNED_HOME_PREFIX)
  ) {
    throw new Error(`refusing unowned E2E test-server home: ${home.path}`);
  }
  const marker = readFileSync(join(canonicalHome, OWNERSHIP_MARKER), "utf8");
  if (marker !== home.token) {
    throw new Error(`invalid E2E test-server home ownership: ${home.path}`);
  }
}

export function removeOwnedTestServerHome(home: OwnedTestServerHome): void {
  if (!existsSync(home.path)) return;
  assertOwnedTestServerHome(home);
  rmSync(home.path, { recursive: true, force: true });
}
