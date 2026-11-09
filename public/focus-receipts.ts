import { focusNextRefKey, type FocusTriage } from "../src/focus-contract";
export interface FocusSendReceipt { label: string; at: string; state: "sending" | "sent" | "check" | "retry" }
const STORAGE_KEY = "wolfpack-focus-send-receipts-v1";
const RECEIPT_CAP = 200;
export function focusSuggestionKey(row: FocusTriage): string {
  return JSON.stringify([focusNextRefKey(row.ref), Date.parse(row.stoppedAt ?? ""), row.suggestion]);
}
/** Browser-owned duplicate-send fences, not B2's server-side send log. Persist before
 * any network write. Never evict a receipt to make a potentially delivered send retryable. */
export function createFocusReceipts(storage: Pick<Storage, "getItem" | "setItem">) {
  const pendingHere = new Set<string>();
  function read(): Map<string, FocusSendReceipt> {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null) return new Map();
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > RECEIPT_CAP || !entries.every(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length > 2000) return false;
        const value = entry[1];
        return value && typeof value === "object" && typeof value.label === "string" && value.label.length <= 1000
          && typeof value.at === "string" && Number.isFinite(Date.parse(value.at))
          && ["sending", "sent", "check", "retry"].includes(value.state);
      })) throw new Error("invalid receipt data");
      return new Map(entries);
    } catch { throw new Error("Suggestion receipts unavailable; check the session before sending."); }
  }
  return {
    get(key: string): FocusSendReceipt | undefined {
      const value = read().get(key);
      return value?.state === "sending" && !pendingHere.has(key)
        ? { ...value, state: "check", label: "delivery unconfirmed · check the session" } : value;
    },
    put(key: string, receipt: FocusSendReceipt) {
      const values = read();
      if (!values.has(key) && values.size >= RECEIPT_CAP) throw new Error("Suggestion receipts full; use the session directly instead.");
      values.set(key, receipt);
      try { storage.setItem(STORAGE_KEY, JSON.stringify([...values])); }
      catch { throw new Error("Suggestion receipts could not be saved; check the session before sending again."); }
      if (receipt.state === "sending") pendingHere.add(key); else pendingHere.delete(key);
    },
  };
}
