/** Focus manager summaries must expose only visible, single-line text. Normal terminal
 * previews keep their original emoji formatting; this projection is focus-owned only. */
export function focusLastLine(text: string): string {
  return Array.from(text.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, "").trim()).slice(0, 300).join("");
}
