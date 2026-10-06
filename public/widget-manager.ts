import type { ExtensionCatalogEnvelope } from "../src/extensions/runtime-contract.ts";
import { browserAuthFetch } from "./browser-auth.ts";
import { parseExtensionCatalog } from "./extension-host.ts";
import type { WidgetVisibility } from "./widget-visibility.ts";

/** Inventory is metadata-only: never import code, attach a terminal, or mutate packages here. */
export function createWidgetManager(options: {
  readonly root: HTMLElement;
  readonly visibility: WidgetVisibility;
  readonly safeMode: () => boolean;
}) {
  const list = options.root.querySelector<HTMLElement>("[data-widget-list]")!;
  const status = options.root.querySelector<HTMLElement>("[data-widget-status]")!;
  const refreshButton = options.root.querySelector<HTMLButtonElement>("[data-widget-refresh]")!;
  let catalog: ExtensionCatalogEnvelope | null = null;
  let request: AbortController | null = null;
  let disposed = false;
  const render = () => {
    if (!catalog || disposed) return;
    const safe = catalog.safeMode || options.safeMode();
    status.textContent = safe ? "Safe mode: installed metadata only; browser extensions are not loaded."
      : catalog.installations.length ? `${catalog.installations.length} installed extensions on this host.` : "No extensions installed on this host.";
    list.replaceChildren();
    for (const item of catalog.installations) {
      const row = document.createElement("article");
      row.className = "widget-manager-item";
      row.dataset.widgetExtension = item.extensionId;
      const heading = document.createElement("h3");
      heading.className = "settings-sub-heading";
      heading.textContent = item.package.name;
      const detail = document.createElement("p");
      detail.className = "settings-description";
      detail.textContent = `${item.extensionId} · ${item.package.version} · ${item.enabled ? "Enabled on this host" : "Disabled on this host"}${item.ui ? "" : " · No browser UI"}`;
      row.append(heading, detail);
      if (item.ui) {
        const label = document.createElement("label");
        label.className = "settings-toggle";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = options.visibility.isVisible(item);
        input.disabled = safe || !item.enabled;
        input.addEventListener("change", () => {
          try {
            options.visibility.setVisible(item, input.checked);
            status.textContent = "Visibility saved for this browser.";
          } catch {
            input.checked = options.visibility.isVisible(item);
            status.textContent = "Could not save widget visibility. Browser storage is unavailable.";
          }
        });
        label.append(input, document.createTextNode(`Show widgets from ${item.extensionId}`));
        row.append(label);
      }
      list.append(row);
    }
  };
  const refresh = async () => {
    if (disposed) return;
    request?.abort();
    const active = request = new AbortController();
    const timer = setTimeout(() => active.abort(), 5_000);
    catalog = null;
    list.replaceChildren();
    status.textContent = "Loading installed extensions…";
    refreshButton.disabled = true;
    try {
      const response = await browserAuthFetch("/api/extensions", { cache: "no-store", signal: active.signal });
      if (!response.ok) throw new Error("inventory unavailable");
      const next = parseExtensionCatalog(await response.json());
      if (disposed || active !== request) return;
      if (active.signal.aborted) throw new Error("inventory timeout");
      catalog = next;
      render();
    } catch {
      if (!disposed && active === request) status.textContent = "Installed extensions unavailable. Refresh to try again.";
    } finally {
      clearTimeout(timer);
      if (active === request) { request = null; refreshButton.disabled = false; }
    }
  };
  const onRefresh = () => { void refresh(); };
  refreshButton.addEventListener("click", onRefresh);
  // Update existing inputs, rather than replacing the focused checkbox on a local change.
  const unsubscribe = options.visibility.subscribe(() => {
    for (const item of catalog?.installations ?? []) {
      const input = list.querySelector<HTMLInputElement>(`[data-widget-extension="${item.extensionId}"] input`);
      if (input) input.checked = options.visibility.isVisible(item);
    }
  });
  return { refresh, render, dispose() { disposed = true; request?.abort(); unsubscribe(); refreshButton.removeEventListener("click", onRefresh); } };
}
