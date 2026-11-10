export interface DayNoteSections {
  writeUps: { label?: string; text: string }[];
  details: string;
  pending: boolean;
}
/** A generated later header starts a new facts/write-up block. Assistant headings
 * delimit authored prose; none of that prose belongs in the collapsed facts. */
export function dayNoteSections(markdown: string): DayNoteSections {
  const blocks = markdown.split(/(?=^# later · after[^\r\n]*\r?$)/m);
  const writeUps: DayNoteSections["writeUps"] = [];
  const facts: string[] = [];
  let pending = false;
  for (const [index, raw] of blocks.entries()) {
    // The producer's separator belongs to the next generated block, not the prose.
    const block = (index < blocks.length - 1 ? raw.replace(/\r?\n---(?:\r?\n)*$/, "") : raw).trim();
    const label = /^# (later · after[^\r\n]*)/.exec(block)?.[1];
    const headings = [...block.matchAll(/^## assistant[\t ]*\r?$/gm)];
    const generated = block.slice(0, headings[0]?.index ?? block.length).trim();
    if (generated) facts.push(generated);
    let lastText = "";
    for (const [i, heading] of headings.entries()) {
      lastText = block.slice(heading.index! + heading[0].length, headings[i + 1]?.index ?? block.length).trim();
      if (lastText) writeUps.push({ ...(label && { label }), text: lastText });
    }
    pending = !!label && !lastText;
  }
  return { writeUps, details: facts.join("\n\n---\n\n"), pending };
}

/** Render the skill's small heading/bullet format using text nodes only. */
function appendWriteUp(host: HTMLElement, prose: string) {
  let list: HTMLUListElement | undefined;
  for (const line of prose.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) { list = undefined; continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(text);
    if (heading || ["done", "still open", "needs you tomorrow"].includes(text)) {
      const el = document.createElement("h3"); el.textContent = heading?.[1] ?? text; host.append(el); list = undefined;
    } else if (/^[-*]\s+/.test(text)) {
      if (!list) { list = document.createElement("ul"); host.append(list); }
      const item = document.createElement("li"); item.textContent = text.replace(/^[-*]\s+/, ""); list.append(item);
    } else {
      const el = document.createElement("p"); el.textContent = text; host.append(el); list = undefined;
    }
  }
}

function localUpdateLabel(label: string): string {
  const prefix = "later · after ";
  if (!label.startsWith(prefix)) return label;
  const at = new Date(label.slice(prefix.length));
  return Number.isFinite(at.getTime())
    ? `${prefix}${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : label;
}

/** All authored reviews stay visible in order; only generated facts are collapsed. */
export function createDayNoteContent(markdown: string): HTMLElement {
  const { writeUps, details, pending } = dayNoteSections(markdown);
  const root = document.createElement("div"); root.className = "focus-note";
  const review = document.createElement("section"); review.setAttribute("aria-label", "Assistant write-ups");
  if (!writeUps.length) {
    const empty = document.createElement("p"); empty.textContent = "No assistant write-up yet."; review.append(empty);
  }
  for (const writeUp of writeUps) {
    const section = document.createElement("section");
    if (writeUp.label) {
      const label = document.createElement("p"); label.className = "focus-context-note"; label.textContent = localUpdateLabel(writeUp.label); section.append(label);
    }
    appendWriteUp(section, writeUp.text); review.append(section);
  }
  if (pending) {
    const status = document.createElement("p"); status.className = "focus-context-note"; status.textContent = "Update pending."; review.append(status);
  }
  const source = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = "Generated facts";
  const raw = document.createElement("pre"); raw.className = "app-dialog-scroll"; raw.tabIndex = 0;
  raw.textContent = details || "No generated facts.";
  source.append(summary, raw); root.append(review, source);
  return root;
}
