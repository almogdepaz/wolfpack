import { expect, type Page } from "@playwright/test";
import type { WidgetArea } from "../../public/widget-layout.ts";

/** User-driven pointer docking; no synthetic drop or internal layout hooks. */
export async function dockPanel(page: Page, title: string, area: WidgetArea): Promise<void> {
  const handle = page.getByRole("button", { name: `Move ${title}`, exact: true });
  if (!await handle.isVisible()) await page.getByRole("tab", { name: title, exact: true }).click();
  await expect(handle).toBeVisible();
  const start = (await handle.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height / 2, { steps: 2 });
  const target = page.locator(`[data-dock-target="${area}"]`);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("aria-disabled", "false");
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await expect(target).toHaveAttribute("data-active", "true");
  await page.mouse.up();
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
}
