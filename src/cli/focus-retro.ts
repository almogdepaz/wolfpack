import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseActivityLines } from "../activity-journal.js";
import { isFocusUiRow } from "../focus-ui-log.js";
import { parseJournalLines } from "../journal-lines.js";
import { buildFocusRetro, isRetroDate, type FocusRetro } from "../focus-retro.js";
import { resolveWolfpackDir } from "../wolfpack-dir.js";
export const FOCUS_RETRO_USAGE = "Usage: wolfpack focus retro [--date YYYY-MM-DD] [--json] (local UTC day; no server required)";
export function parseFocusRetroCommand(args: readonly string[], now = new Date()): { date: string; json: boolean } {
  let date = now.toISOString().slice(0, 10), json = false, dated = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (args[i] === "--date" && !dated && args[i + 1] !== undefined) { date = args[++i]!; dated = true; }
    else throw new Error(FOCUS_RETRO_USAGE);
  }
  if (!isRetroDate(date)) throw new Error(FOCUS_RETRO_USAGE);
  return { date, json };
}
function read(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
/** Read-only, including torn tails. Never instantiate a writer or contact a peer/server. */
export function readLocalFocusRetro(date: string, root = resolveWolfpackDir()): FocusRetro {
  if (!isRetroDate(date)) throw new Error(FOCUS_RETRO_USAGE);
  const ui = parseJournalLines(read(join(root, "focus-ui", `${date}.jsonl`)), isFocusUiRow).rows;
  const activity = parseActivityLines(read(join(root, "activity", `${date}.jsonl`))).rows;
  const machine = read(process.env.WOLFPACK_MACHINE_ID_PATH ?? join(root, "machine-id")).trim() || undefined;
  return buildFocusRetro(date, ui, activity, machine);
}
const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
const duration = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export function formatFocusRetro(retro: FocusRetro): string {
  const lines = [`focus retro ${retro.date} (UTC; local logs, best-effort attribution)`, "visits:"];
  for (const visit of retro.visits) lines.push(`  ${visit.openedAt} → ${visit.leftAt ?? "leave not recorded"} · ${visit.visibleMs === null ? "duration unknown" : duration(visit.visibleMs)} visible`);
  lines.push("shown cards:");
  for (const card of retro.cards) lines.push(`  ${card.shownAt} #${card.rank} ${safe(card.session)} @ ${safe(card.machine)} (${card.kind}/${card.reason}) → ${card.firstAction ? `${card.firstAction.control} after ${duration(card.firstAction.latencyMs)}` : "ignored (no action recorded)"}`);
  lines.push("needs input:");
  for (const episode of retro.needsInput) lines.push(`  ${episode.startedAt} ${safe(episode.session)} → ${episode.resolutionMs === null ? "unresolved in this day" : `${duration(episode.resolutionMs)} · ${episode.via}${episode.focusAction ? ` (${episode.focusAction})` : ""}`}`);
  return lines.join("\n");
}
