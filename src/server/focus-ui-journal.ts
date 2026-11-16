import { join } from "node:path";
import { isFocusUiRow, type FocusUiEvent, type FocusUiRow } from "../focus-ui-log.js";
import { parseJournalLines } from "../journal-lines.js";
import { resolveWolfpackDir } from "../wolfpack-dir.js";
import { DayJournal, type DayJournalOptions } from "./day-journal.js";
/** Local-only: intentionally not part of activity's peer paging contract. */
export class FocusUiJournal extends DayJournal<FocusUiRow, FocusUiEvent> {
  constructor(options: Partial<DayJournalOptions> = {}) {
    super({ ...options, dir: options.dir ?? join(resolveWolfpackDir(), "focus-ui") }, {
      parse: text => parseJournalLines(text, isFocusUiRow), serialize: row => JSON.stringify(row) + "\n",
    });
  }
  override append(event: FocusUiEvent): FocusUiRow { return super.append(event, event.at); }
}
