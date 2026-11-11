import { expect, type Locator } from "@playwright/test";

/** Exercise the native disclosure before touching its controls. */
export async function expandFocusCard(row: Locator) {
  const card = row.locator(":scope > details.focus-card");
  await expect(card).toBeVisible();
  if (!await card.evaluate(el => (el as HTMLDetailsElement).open)) await card.locator(":scope > summary").click();
  await expect(card).toHaveAttribute("open", "");
}
