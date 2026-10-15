/** Why `POST /api/notify` delivered nothing; present only when `delivered` is false. */
export const NOTIFY_UNDELIVERED_REASON = {
  /** No enrolled subscription remained on this host (none, or all expired and pruned). */
  NO_SUBSCRIPTIONS: "no_subscriptions",
  /** Every remaining subscription failed. */
  DELIVERY_FAILED: "delivery_failed",
} as const;

export type NotifyUndeliveredReason = (typeof NOTIFY_UNDELIVERED_REASON)[keyof typeof NOTIFY_UNDELIVERED_REASON];

export type NotifyDelivery =
  | { readonly delivered: true; readonly reason?: never }
  | { readonly delivered: false; readonly reason: NotifyUndeliveredReason };

/** A notification is delivered when at least one push was accepted. */
export function notifyDelivery(result: { readonly sent: number; readonly failed: number }): NotifyDelivery {
  if (result.sent > 0) return { delivered: true };
  return {
    delivered: false,
    reason: result.failed > 0 ? NOTIFY_UNDELIVERED_REASON.DELIVERY_FAILED : NOTIFY_UNDELIVERED_REASON.NO_SUBSCRIPTIONS,
  };
}
