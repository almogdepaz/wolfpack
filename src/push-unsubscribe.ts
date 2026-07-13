export interface NotificationUnsubscribeState {
  notificationsEnabled: boolean;
  notificationUnsubscribePending: boolean;
  notificationUnsubscribeInFlight: boolean;
}

export interface PushSubscriptionHandle {
  readonly endpoint: string;
  unsubscribe(): Promise<boolean>;
}

export interface ServerCleanupResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type PushUnsubscribeOutcome =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly error: unknown };

export async function unsubscribePushNotifications(
  state: NotificationUnsubscribeState,
  getSubscription: () => Promise<PushSubscriptionHandle | null>,
  removeFromServer: (endpoint: string) => Promise<ServerCleanupResponse>,
): Promise<PushUnsubscribeOutcome> {
  if (state.notificationUnsubscribeInFlight) {
    return { ok: false, error: new Error("push unsubscribe already in progress") };
  }
  state.notificationUnsubscribeInFlight = true;
  try {
    const subscription = await getSubscription();
    if (!subscription) {
      state.notificationUnsubscribePending = false;
      state.notificationsEnabled = false;
      return { ok: true, removed: false };
    }

    const response = await removeFromServer(subscription.endpoint);
    if (!response.ok) throw new Error(`server cleanup failed: ${response.status}`);

    const removed = await subscription.unsubscribe();
    if (!removed) throw new Error("browser subscription was not removed");
    state.notificationUnsubscribePending = false;
    state.notificationsEnabled = false;
    return { ok: true, removed: true };
  } catch (error: unknown) {
    state.notificationUnsubscribePending = true;
    return { ok: false, error };
  } finally {
    state.notificationUnsubscribeInFlight = false;
  }
}
