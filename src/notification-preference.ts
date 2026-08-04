export const NOTIFICATION_CHANGE_FAILURE = {
  UNSUPPORTED: "unsupported",
  PERMISSION_DENIED: "permission-denied",
  SERVICE_WORKER: "service-worker-failed",
  SUBSCRIPTION: "subscription-failed",
  SERVER: "server-registration-failed",
  UNSUBSCRIBE: "unsubscribe-failed",
} as const;

export type NotificationChangeFailure =
  (typeof NOTIFICATION_CHANGE_FAILURE)[keyof typeof NOTIFICATION_CHANGE_FAILURE];

export type NotificationChangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: NotificationChangeFailure };

export interface NotificationPreferenceChange {
  readonly current: boolean;
  readonly requested: boolean;
  readonly changeSubscription: () => Promise<NotificationChangeResult>;
  readonly commit: (enabled: boolean) => void;
}

export interface NotificationPreferenceOutcome {
  readonly enabled: boolean;
  readonly change: NotificationChangeResult;
}

export async function applyNotificationPreference(
  preference: NotificationPreferenceChange,
): Promise<NotificationPreferenceOutcome> {
  const change = await preference.changeSubscription();
  const enabled = change.ok
    ? preference.requested
    : preference.requested
      ? false
      : preference.current;
  preference.commit(enabled);
  return { enabled, change };
}
