import { join } from "node:path";
import { readValidatedJsonFile, writePrivateJsonFile } from "../persistence.ts";
import { resolveWolfpackDir } from "../wolfpack-dir.ts";
import { createLogger, errMsg } from "../log.ts";
import { normalizeOrganizationUpdate, SESSION_ORGANIZATION_ID, SessionOrganizationError } from "../session-organization-contract.ts";
import type { SessionOrganization, SessionOrganizationProjection } from "../session-organization-contract.ts";

const log = createLogger("server");
interface RecordV1 { version: 1; organization: SessionOrganization }
function validRecord(value: unknown): value is RecordV1 {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as RecordV1;
    if (record.version !== 1 || Object.keys(record).sort().join(",") !== "organization,version") return false;
    const org = record.organization;
    if (!org || Object.keys(org).sort().join(",") !== "group,revision,tags") return false;
    const canonical = normalizeOrganizationUpdate({ expectedRevision: org.revision, group: org.group, tags: org.tags });
    return canonical.group === org.group && JSON.stringify(canonical.tags) === JSON.stringify(org.tags);
  } catch { return false; }
}

/** One context-owned writer. Synchronous CAS is instance/process-local, not a cross-process lock.
 * No inventory reconciliation or GC: absent broker facts must never delete annotations.
 */
export class SessionOrganizationService {
  private readonly root: string;
  private readonly write: (path: string, value: unknown) => void;
  constructor(options: { root?: string; write?: (path: string, value: unknown) => void } = {}) {
    this.root = options.root ?? join(resolveWolfpackDir(), "session-organization");
    this.write = options.write ?? writePrivateJsonFile;
  }
  private path(sessionId: string): string {
    if (!SESSION_ORGANIZATION_ID.test(sessionId)) throw new SessionOrganizationError("INVALID_ORGANIZATION", "canonical session UUID required");
    return join(this.root, `${sessionId}.json`);
  }
  read(sessionId: string): SessionOrganization {
    return readValidatedJsonFile(this.path(sessionId), "session organization", validRecord)?.organization ?? { group: null, tags: [], revision: 0 };
  }
  /** Optional enrichment never changes terminal truth; diagnostics stay server-side. */
  project(sessionId: string): SessionOrganizationProjection {
    try { return this.read(sessionId); }
    catch (error) { log.warn("organization unavailable", { sessionId, error: errMsg(error) }); return { status: "unavailable" }; }
  }
  update(sessionId: string, update: unknown): SessionOrganization {
    const canonical = normalizeOrganizationUpdate(update);
    const current = this.read(sessionId);
    if (canonical.expectedRevision !== current.revision) throw new SessionOrganizationError("ORGANIZATION_CONFLICT", "organization revision conflict; reload and review before saving");
    const next = { group: canonical.group === undefined ? current.group : canonical.group, tags: canonical.tags ?? current.tags, revision: current.revision + 1 };
    if (next.group === current.group && JSON.stringify(next.tags) === JSON.stringify(current.tags)) return current;
    if (!Number.isSafeInteger(next.revision)) throw new SessionOrganizationError("INVALID_ORGANIZATION", "organization revision exhausted");
    this.write(this.path(sessionId), { version: 1, organization: next } satisfies RecordV1);
    return next;
  }
}
