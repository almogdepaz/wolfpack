/** Split only punctuation followed by whitespace and an uppercase/digit start.
 * Initialisms, short abbreviation tokens and common longer abbreviations keep
 * their dot. Ambiguous prose stays in the ask rather than losing its object. */
export function focusHeadlineParts(text: string): { ask: string; why: string } {
  for (const match of text.matchAll(/[.?!](?=\s+[\p{Lu}\d])/gu)) {
    const end = match.index + 1;
    const token = text.slice(0, end).match(/[\p{L}.]+$/u)?.[0] ?? "";
    if (match[0] === "." && /^(?:(?:\p{L}\.)+|\p{L}{1,3}\.|(?:prof|approx|dept|corp)\.)$/iu.test(token)) continue;
    return { ask: text.slice(0, end), why: text.slice(end).trim() };
  }
  return { ask: text, why: "" };
}

/** Hide terminal chrome only when there is a literal spaced pipe and every
 * segment is a known model/version or numeric tokens/ctx/context-left/cost field.
 * Prose and unfamiliar status formats stay visible: a miss is safer than hiding an ask. */
export function isFocusStatusBar(text: string): boolean {
  const model = /^(?:(?:claude[- ]?)?(?:opus|sonnet|haiku)[- ]\d[\w.-]*|gpt-\d[\w.-]*|gemini[- ]\d[\w.-]*)$/i;
  const metric = /^(?:tokens?|ctx|context left|cost)\s*[:=]\s*[$€£]?\d[\d.,kKmM% ]*(?:left|usd)?$/i;
  return text.includes(" | ") && text.split(" | ").every(part => model.test(part.trim()) || metric.test(part.trim()));
}

/** Focus manager summaries must expose only visible, single-line text. Normal terminal
 * previews keep their original emoji formatting; this projection is focus-owned only. */
export function focusLastLine(text: string): string {
  return Array.from(text.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, "").trim()).slice(0, 300).join("");
}
