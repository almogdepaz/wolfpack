export const FOCUS_MOBILE_EXPANDED_KEY = "wolfpack-focus-mobile-expanded-v1";
/** A device preference overrides attention; denied storage keeps the choice in memory. */
export function createFocusMobileDisclosure(storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage) {
  let preference: boolean | undefined;
  try {
    const value = storage().getItem(FOCUS_MOBILE_EXPANDED_KEY);
    if (value === "1" || value === "0") preference = value === "1";
  } catch { /* storage unavailable: use attention until the user chooses */ }
  return {
    expanded: (attention: boolean) => preference ?? attention,
    toggle(attention: boolean) {
      preference = !(preference ?? attention);
      try { storage().setItem(FOCUS_MOBILE_EXPANDED_KEY, preference ? "1" : "0"); }
      catch { /* quota/security errors do not lose the in-memory choice */ }
    },
  };
}
