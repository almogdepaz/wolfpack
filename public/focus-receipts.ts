import { focusNextRefKey, type FocusTriage, type FocusNextRef } from "../src/focus-contract";
// User-approved one-line suggestion editor limit; session-send itself has only a request-body byte cap.
export const FOCUS_REPLY_MAX_LENGTH = 2000;
export interface FocusSendReceipt { label: string; at: string; state: "sending" | "sent" | "check" | "retry"; text?: string }
const STORAGE_KEY = "wolfpack-focus-send-receipts-v1";
const RECEIPT_CAP = 200;
const LABEL_CAP = 1000;
const SETTLED_RETENTION_MS = 7 * 86400_000;
function validReceipt(value: unknown): value is FocusSendReceipt {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.text === undefined || typeof v.text === "string" && v.text.length <= FOCUS_REPLY_MAX_LENGTH)
    && typeof v.label === "string" && v.label.length <= LABEL_CAP
    && typeof v.at === "string" && Number.isFinite(Date.parse(v.at))
    && typeof v.state === "string" && ["sending", "sent", "check", "retry"].includes(v.state);
}
export function focusSuggestionKey(row: FocusTriage): string {
  return JSON.stringify(["suggest", focusNextRefKey(row.ref), Date.parse(row.stoppedAt ?? ""), row.suggestion]);
}
/** Free-text replies are fenced by episode, never by the user's changing draft. */
export function focusReplyKey(ref: FocusNextRef, stoppedAt: string): string {
  return JSON.stringify(["reply", focusNextRefKey(ref), Date.parse(stoppedAt)]);
}
/** Decode only our two tagged domains and the historical untagged tuple. The old
 * literal suggestion `reply` is ambiguous: fence it, but never claim it matches a new suggestion. */
function receiptIdentity(key: string): { episode: string; legacyKey?: string } | undefined {
  let parts: unknown;
  try { parts = JSON.parse(key); } catch { return; } // Other storage keys have no episode identity.
  if (!Array.isArray(parts)) return;
  const tagged = parts[0] === "suggest" && parts.length === 4 || parts[0] === "reply" && parts.length === 3;
  if (!tagged && parts.length !== 3) return;
  const ref = parts[tagged ? 1 : 0], at = parts[tagged ? 2 : 1];
  if (typeof ref !== "string" || typeof at !== "number" || !Number.isFinite(at)) return;
  const legacyKey = tagged && (parts[0] === "reply" || parts[3] !== "reply")
    ? JSON.stringify([ref, at, parts[0] === "reply" ? "reply" : parts[3]]) : undefined;
  return { episode: JSON.stringify([ref, at]), legacyKey };
}
/** Browser-owned duplicate-send fences, not B2's server-side send log. Persist before
 * any network write. Reclaim only settled fences older than seven days; recent and
 * in-flight fences are never evicted for capacity. B2 owns server-side episode dedupe. */
export function createFocusReceipts(storage: Pick<Storage, "getItem" | "setItem">, now: () => number = Date.now) {
  const pendingHere = new Set<string>();
  function read(): Map<string, FocusSendReceipt> {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null) return new Map();
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > RECEIPT_CAP || !entries.every(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length > 2000) return false;
        return validReceipt(entry[1]);
      })) throw new Error("invalid receipt data");
      return new Map<string, FocusSendReceipt>(entries.filter(([, value]) => value.state === "sending" || now() - Date.parse(value.at) <= SETTLED_RETENTION_MS));
    } catch { throw new Error("Suggestion receipts unavailable; check the session before sending."); }
  }
  const settled = (key: string, value: FocusSendReceipt): FocusSendReceipt => value.state === "sending" && !pendingHere.has(key)
    ? { ...value, state: "check", label: "delivery unconfirmed · check the session" } : value;
  return {
    get(key: string): FocusSendReceipt | undefined {
      const values = read();
      const found = values.has(key) ? key : receiptIdentity(key)?.legacyKey;
      if (!found) return;
      const value = values.get(found);
      return value ? settled(found, value) : undefined;
    },
    /** A non-delivered attempt may retry; every other action on this physical stop stays fenced. */
    forEpisode(key: string): FocusSendReceipt | undefined {
      const episode = receiptIdentity(key)?.episode;
      if (!episode) return;
      let latest: { key: string; value: FocusSendReceipt } | undefined;
      for (const [storedKey, value] of read()) {
        if (value.state !== "retry" && receiptIdentity(storedKey)?.episode === episode
          && (!latest || Date.parse(value.at) >= Date.parse(latest.value.at))) latest = { key: storedKey, value };
      }
      return latest && settled(latest.key, latest.value);
    },
    put(key: string, receipt: FocusSendReceipt) {
      const values = read();
      if (!values.has(key) && values.size >= RECEIPT_CAP) throw new Error("Suggestion receipts full; use the session directly instead.");
      const bounded = { ...receipt, label: receipt.label.slice(0, LABEL_CAP) };
      if (key.length > 2000 || !validReceipt(bounded)) throw new Error("Invalid suggestion receipts write; nothing was changed.");
      values.set(key, bounded);
      try { storage.setItem(STORAGE_KEY, JSON.stringify([...values])); }
      catch { throw new Error("Suggestion receipts could not be saved; check the session before sending again."); }
      if (receipt.state === "sending") pendingHere.add(key); else pendingHere.delete(key);
    },
  };
}
