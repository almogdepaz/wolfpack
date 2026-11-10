export const FOCUS_MOBILE_EXPANDED_KEY = "wolfpack-focus-mobile-expanded-v1";
export const FOCUS_DESKTOP_EXPANDED_KEY = "wolfpack-focus-desktop-expanded-v1";
/** A device preference overrides attention; denied storage keeps the choice in memory. */
export function createFocusMobileDisclosure(storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage,
  { key = FOCUS_MOBILE_EXPANDED_KEY, defaultExpanded = false }: { key?: string; defaultExpanded?: boolean } = {}) {
  let preference: boolean | undefined;
  try {
    const value = storage().getItem(key);
    if (value === "1" || value === "0") preference = value === "1";
  } catch { /* storage unavailable: use attention until the user chooses */ }
  return {
    expanded: (attention: boolean) => preference ?? (defaultExpanded || attention),
    toggle(attention: boolean) {
      preference = !(preference ?? (defaultExpanded || attention));
      try { storage().setItem(key, preference ? "1" : "0"); }
      catch { /* quota/security errors do not lose the in-memory choice */ }
    },
  };
}
