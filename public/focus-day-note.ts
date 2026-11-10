/** The durable heading is the only delimiter; never interpret generated facts as HTML. */
export function dayNoteSections(markdown: string): { writeUp: string; details: string } {
  const last = [...markdown.matchAll(/^## assistant[\t ]*\r?$/gm)].at(-1);
  return last ? { writeUp: markdown.slice(last.index! + last[0].length).trim(), details: markdown.slice(0, last.index).trim() }
    : { writeUp: "", details: markdown.trim() };
}

/** Render the skill's small heading/bullet format using text nodes only. Legacy prose
 * remains paragraphs. Generated facts and earlier write-ups stay reachable, collapsed. */
export function createDayNoteContent(markdown: string): HTMLElement {
  const { writeUp, details } = dayNoteSections(markdown);
  const root = document.createElement("div"); root.className = "focus-note";
  const review = document.createElement("section"); review.setAttribute("aria-label", "Latest assistant write-up");
  let list: HTMLUListElement | undefined;
  if (!writeUp) {
    const empty = document.createElement("p"); empty.textContent = "No assistant write-up yet."; review.append(empty);
  }
  for (const line of writeUp.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) { list = undefined; continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(text);
    if (heading || ["done", "still open", "needs you tomorrow"].includes(text)) {
      const el = document.createElement("h3"); el.textContent = heading?.[1] ?? text; review.append(el); list = undefined;
    } else if (/^[-*]\s+/.test(text)) {
      if (!list) { list = document.createElement("ul"); review.append(list); }
      const item = document.createElement("li"); item.textContent = text.replace(/^[-*]\s+/, ""); list.append(item);
    } else {
      const el = document.createElement("p"); el.textContent = text; review.append(el); list = undefined;
    }
  }
  const source = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = "Generated facts and earlier notes";
  const raw = document.createElement("pre"); raw.className = "app-dialog-scroll"; raw.tabIndex = 0;
  raw.textContent = details || "No generated facts.";
  source.append(summary, raw); root.append(review, source);
  return root;
}
