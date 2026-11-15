/** Sentence punctuation must end the text or precede whitespace; dots inside
 * versions, filenames and URLs are not sentence ends. Legacy prose stays intact. */
export function focusHeadlineParts(text: string): { ask: string; why: string } {
  const end = text.search(/[.?](?=\s|$)/u);
  return end < 0 ? { ask: text, why: "" } : { ask: text.slice(0, end + 1), why: text.slice(end + 1).trim() };
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
