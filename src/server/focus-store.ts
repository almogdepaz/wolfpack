import { join } from "node:path";
import { emptyFocus, isFocusDocument, reduceFocus, type FocusDocument } from "../focus-contract.js";
import { readValidatedJsonFile, writePrivateJsonFile } from "../persistence.js";
import { resolveWolfpackDir } from "../wolfpack-dir.js";
export class FocusValidationError extends Error {}
export class FocusConflict extends Error {
  constructor(readonly document: FocusDocument | null) { super("focus revision conflict"); }
}
/** One home server owns the file. Synchronous read/reduce/atomic write is a single CAS turn. */
export class FocusStore {
  constructor(readonly path = join(resolveWolfpackDir(), "assistant", "focus.json")) {}
  read(): FocusDocument | null { return readValidatedJsonFile(this.path, "focus", isFocusDocument); }
  update(expectedRevision: number, ops: unknown): FocusDocument {
    const document = this.read();
    if ((document?.revision ?? 0) !== expectedRevision) throw new FocusConflict(document);
    let next: FocusDocument;
    try { next = reduceFocus(document ?? emptyFocus(), ops, new Date().toISOString()); }
    catch (error) { throw new FocusValidationError(error instanceof Error ? error.message : "invalid focus operations"); }
    writePrivateJsonFile(this.path, next);
    return next;
  }
}
